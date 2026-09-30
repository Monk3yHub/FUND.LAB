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

// ฟังก์ชันแปลงและล้างชื่อย่อ (ตัดอักขระพิเศษ และแปลง SCBNKY -> SCBNK)
function normalizeCode(str) {
  if (!str) return '';
  let cleaned = str.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.startsWith('SCBNKY')) {
    cleaned = 'SCBNK' + cleaned.slice(6);
  }
  return cleaned;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ฟังก์ชันดึงข้อมูลพร้อม Retry เมื่อติด Rate Limit (HTTP 429)
async function fetchSecNavWithRetry(url, retries = 3) {
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

async function updateNav() {
  console.log('🚀 เริ่มต้นอัปเดตราคา NAV ครอบคลุมทุก Class...');

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

  const today = new Date().toISOString().split('T')[0];
  const past30Days = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

  const navHistoryList = [];
  let processedCount = 0;

  for (const [projId, fundList] of projMap.entries()) {
    processedCount++;
    if (processedCount % 50 === 0 || processedCount === projMap.size) {
      console.log(`⏳ ประมวลผลสำเร็จแล้ว ${processedCount}/${projMap.size} โครงการ...`);
    }

    const url = `https://api.sec.or.th/FundDailyInfo/${encodeURIComponent(projId)}/NAV/daily/${past30Days}/${today}`;

    // หน่วงเวลาเล็กน้อย 30ms ป้องกันโดนล็อก Rate Limit
    await sleep(30);

    const secData = await fetchSecNavWithRetry(url);
    if (!Array.isArray(secData) || secData.length === 0) continue;

    const validSecItems = secData.filter((item) => {
      const rawNav = item.nav ?? item.last_val;
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
      const fundCodeNorm = normalizeCode(fund.code);
      const fundClassNorm = normalizeCode(fund.fund_class_name);

      for (const [navDate, itemsOnDate] of secDataByDate.entries()) {
        let matchedItem = null;

        // 1. Match ตรงตัว
        matchedItem = itemsOnDate.find((item) => {
          const secClass = (item.fund_class_name || item.class_abbr_name || item.proj_abbr_name || '').trim().toUpperCase();
          return secClass === fund.code.trim().toUpperCase() ||
                 (fund.fund_class_name && secClass === fund.fund_class_name.trim().toUpperCase());
        });

        // 2. Normalize Match (จัดการชื่อย่อ SCBNKY -> SCBNK)
        if (!matchedItem) {
          matchedItem = itemsOnDate.find((item) => {
            const secClassNorm = normalizeCode(item.fund_class_name || item.class_abbr_name || item.proj_abbr_name);
            if (!secClassNorm) return false;
            return secClassNorm === fundCodeNorm ||
                   (fundClassNorm && secClassNorm === fundClassNorm) ||
                   secClassNorm.includes(fundCodeNorm) ||
                   fundCodeNorm.includes(secClassNorm);
          });
        }

        // 3. Fallback หาก SEC ส่งราคามาในระดับโครงการ
        if (!matchedItem && itemsOnDate.length > 0) {
          matchedItem = itemsOnDate[0];
        }

        if (matchedItem) {
          const navValue = parseFloat(matchedItem.nav ?? matchedItem.last_val);
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
