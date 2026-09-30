import ws from 'ws';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY?.trim();
const SEC_API_KEY = process.env.SEC_API_KEY?.trim();

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SEC_API_KEY) {
  console.error('❌ กรุณาตั้งค่า SUPABASE_URL, SUPABASE_SERVICE_KEY และ SEC_API_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws },
});

// ฟังก์ชันแปลงและล้างชื่อย่อ (ตัดอักขระพิเศษ และแปลง SCBNKY -> SCBNK) — คงไว้ตามเดิม ใช้เป็น fallback เท่านั้น
function normalizeCode(str) {
  if (!str) return '';
  let cleaned = str.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.startsWith('SCBNKY')) {
    cleaned = 'SCBNK' + cleaned.slice(6);
  }
  return cleaned;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ฟังก์ชันดึงข้อมูลพร้อม Retry เมื่อติด Rate Limit (HTTP 429) — คงไว้ตามเดิม
async function fetchJsonWithRetry(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'Ocp-Apim-Subscription-Key': SEC_API_KEY },
      });

      if (res.status === 429) {
        console.warn(`⚠️ SEC API Rate Limited (429). รอ 1.5 วินาทีแล้วลองใหม่ (รอบที่ ${attempt})...`);
        await sleep(1500);
        continue;
      }

      if (!res.ok) {
        console.error(`❌ SEC API Error Status ${res.status} [URL: ${url}]`);
        return null;
      }

      return await res.json();
    } catch (err) {
      if (attempt === retries) {
        console.error(`❌ Network Error:`, err.message);
        return null;
      }
      await sleep(1000);
    }
  }
  return null;
}

// ============================================================
// ✅ ส่วนที่แก้ใหม่: endpoint จริง + รูปแบบ response จริงของ ก.ล.ต.
//    (ยืนยันจาก JSON จริงแล้ว — endpoint นี้คืนค่าเป็น { items: [...] } ไม่ใช่ array เปล่าๆ
//     และมี pagination ผ่าน next_cursor ถ้าข้อมูลเกิน page_size ต่อหน้า)
// ============================================================
async function fetchAllNavItemsForProj(projId, startDate, endDate) {
  const items = [];
  let cursor = '';
  do {
    const url = new URL('https://api.sec.or.th/v2/fund/daily-info/nav');
    url.searchParams.set('proj_id', projId);
    url.searchParams.set('start_nav_date', startDate);
    url.searchParams.set('end_nav_date', endDate);
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('next_cursor', cursor);
    // ⚠️ ไม่ส่ง fund_class_name ตรงนี้ เพราะต้องการ NAV ของทุก class ในโครงการนี้มาในคราวเดียว
    //    แล้วค่อยจับคู่แต่ละ class เองด้านล่าง (ประหยัดจำนวนครั้งที่ยิง API ต่อโครงการ)

    const data = await fetchJsonWithRetry(url.toString());
    if (!data || !Array.isArray(data.items)) break;

    items.push(...data.items);
    cursor = data.next_cursor || '';
    if (cursor) await sleep(30);
  } while (cursor);

  return items;
}

async function updateNav() {
  console.log('🚀 เริ่มต้นอัปเดตราคา NAV ครอบคลุมทุก Class... (ย้อนหลัง 7 วัน)');

  const { data: funds, error: fundsErr } = await supabase
    .from('funds')
    .select('code, proj_id, fund_class_name');

  if (fundsErr || !funds) {
    throw new Error(`ไม่สามารถอ่านตาราง funds ได้: ${fundsErr?.message}`);
  }

  console.log(`📦 พบรายการกองทุนใน DB ทั้งหมด ${funds.length} รายการ`);

  const projMap = new Map();
  for (const fund of funds) {
    if (!fund.proj_id) continue;
    if (!projMap.has(fund.proj_id)) {
      projMap.set(fund.proj_id, []);
    }
    projMap.get(fund.proj_id).push(fund);
  }

  console.log(`🔍 จัดกลุ่มได้ ${projMap.size} โครงการ (proj_id)`);

  // 🔧 เปลี่ยนจากย้อนหลัง 30 วัน → 7 วัน ตามที่ขอ
  const today = new Date().toISOString().split('T')[0];
  const past7Days = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

  const navHistoryList = [];
  let processedCount = 0;

  for (const [projId, fundList] of projMap.entries()) {
    processedCount++;
    if (processedCount % 50 === 0 || processedCount === projMap.size) {
      console.log(`⏳ ประมวลผลสำเร็จแล้ว ${processedCount}/${projMap.size} โครงการ...`);
    }

    // หน่วงเวลาเล็กน้อยระหว่างโครงการ ป้องกันโดนล็อก Rate Limit
    await sleep(30);

    const secItems = await fetchAllNavItemsForProj(projId, past7Days, today);
    if (secItems.length === 0) continue;

    const validSecItems = secItems.filter((item) => {
      const rawNav = item.last_val ?? item.nav;
      return rawNav != null && !isNaN(parseFloat(rawNav));
    });

    if (validSecItems.length === 0) continue;

    const secDataByDate = new Map();
    for (const item of validSecItems) {
      const date = item.nav_date;
      if (!secDataByDate.has(date)) {
        secDataByDate.set(date, []);
      }
      secDataByDate.get(date).push(item);
    }

    for (const fund of fundList) {
      const fundClassUpper = fund.fund_class_name ? fund.fund_class_name.trim().toUpperCase() : '';
      const fundClassNorm = normalizeCode(fund.fund_class_name);
      const fundCodeNorm = normalizeCode(fund.code);

      for (const [navDate, itemsOnDate] of secDataByDate.entries()) {
        let matchedItem = null;

        // ------------------------------------------------------------
        // Step 1: จับคู่ด้วย field ที่ยืนยันแล้วว่าถูกต้องจริง — "fund_class_name"
        //         (ตรงตัว 100% ก่อน — นี่คือทางที่แม่นยำที่สุด ใช้เป็นหลัก)
        // ------------------------------------------------------------
        if (fundClassUpper) {
          matchedItem = itemsOnDate.find(
            (item) => (item.fund_class_name || '').trim().toUpperCase() === fundClassUpper
          );
        }

        // ------------------------------------------------------------
        // Step 2: จับคู่แบบ normalize กันกรณีสะกด/เว้นวรรค/ตัวเล็กใหญ่ไม่ตรงเป๊ะ
        // ------------------------------------------------------------
        if (!matchedItem && fundClassNorm) {
          matchedItem = itemsOnDate.find(
            (item) => normalizeCode(item.fund_class_name) === fundClassNorm
          );
        }

        // ------------------------------------------------------------
        // Step 3: Safe Fallback สำหรับกองทุนแบบ Single Class เท่านั้น
        //         (โครงการนี้มีกองในตาราง funds แค่ 1 แถว และ API คืนมาวันนั้นแค่ 1 รายการ)
        // ------------------------------------------------------------
        if (!matchedItem && fundList.length === 1 && itemsOnDate.length === 1) {
          matchedItem = itemsOnDate[0];
        }

        // ------------------------------------------------------------
        // บันทึกเฉพาะรายการที่จับคู่สำเร็จและมีค่า NAV > 0
        // ------------------------------------------------------------
        if (matchedItem) {
          const rawNav = matchedItem.last_val ?? matchedItem.nav;
          const navValue = parseFloat(rawNav);

          if (!isNaN(navValue) && navValue > 0) {
            navHistoryList.push({
              fund_code: fund.code,
              nav_date: navDate,
              nav: navValue,
              updated_at: new Date().toISOString(),
            });
          }
        }
      }
    }
  }

  console.log(`\n📊 สรุป: จับคู่ราคา NAV ได้ทั้งหมด ${navHistoryList.length} รายการ`);

  if (navHistoryList.length > 0) {
    const chunkSize = 500;
    let savedCount = 0;
    for (let i = 0; i < navHistoryList.length; i += chunkSize) {
      const chunk = navHistoryList.slice(i, i + chunkSize);
      const { error } = await supabase
        .from('nav_history')
        .upsert(chunk, { onConflict: 'fund_code,nav_date' });

      if (error) {
        console.error(`❌ บันทึก nav_history ชุดที่ ${i} ไม่สำเร็จ:`, error.message);
      } else {
        savedCount += chunk.length;
      }
    }
    console.log(`✅ บันทึกราคา NAV ลง nav_history สำเร็จทั้งหมด ${savedCount} รายการ!`);
  } else {
    console.log('⚠️ ไม่พบข้อมูล NAV ที่จะบันทึก');
  }
}

updateNav().catch((err) => {
  console.error('Update NAV failed:', err);
  process.exit(1);
});
