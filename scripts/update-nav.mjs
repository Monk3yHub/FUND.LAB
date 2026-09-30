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

// ฟังก์ชันล้างข้อมูลอักขระพิเศษสำหรับ Normalize
function normalizeCode(str) {
  if (!str) return '';
  let cleaned = str.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.startsWith('SCBNKY')) {
    cleaned = 'SCBNK' + cleaned.slice(6);
  }
  return cleaned;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

    const data = await fetchJsonWithRetry(url.toString());
    if (!data || !Array.isArray(data.items)) break;

    items.push(...data.items);
    cursor = data.next_cursor || '';
    if (cursor) await sleep(30);
  } while (cursor);

  return items;
}

// ============================================================
// 🧠 ฟังก์ชัน Matching พิเศษ: รองรับทุกโครงสร้างฟิลด์ของ SEC API
// ============================================================
function findMatchedSecItem(fund, itemsOnDate, totalFundsInProj) {
  const fundCode = (fund.code || '').trim().toUpperCase();
  const fundClassUpper = (fund.fund_class_name || '').trim().toUpperCase();

  const fundCodeNorm = normalizeCode(fund.code);
  const fundClassNorm = normalizeCode(fund.fund_class_name);

  // Pass 1: Exact Match (เปรียบเทียบ fund.code และ fund_class_name กับทุกฟิลด์ใน SEC)
  for (const item of itemsOnDate) {
    const secClass = (item.fund_class_name || item.fund_class || '').trim().toUpperCase();
    const secAbbr = (item.class_abbr_name || '').trim().toUpperCase();
    const secProjAbbr = (item.proj_abbr_name || '').trim().toUpperCase();

    // 1.1 fund.code ตรงกับ class_abbr_name / fund_class_name / proj_abbr_name
    if (fundCode && (fundCode === secAbbr || fundCode === secClass || fundCode === secProjAbbr)) {
      return item;
    }

    // 1.2 fund.fund_class_name ตรงกับ fund_class_name / class_abbr_name
    if (fundClassUpper && (fundClassUpper === secClass || fundClassUpper === secAbbr)) {
      return item;
    }
  }

  // Pass 2: Clean Normalization Match (ตัดอักขระพิเศษ เว้นวรรค)
  for (const item of itemsOnDate) {
    const secClassNorm = normalizeCode(item.fund_class_name || item.fund_class);
    const secAbbrNorm = normalizeCode(item.class_abbr_name);
    const secProjNorm = normalizeCode(item.proj_abbr_name);

    if (fundCodeNorm && (fundCodeNorm === secAbbrNorm || fundCodeNorm === secClassNorm || fundCodeNorm === secProjNorm)) {
      return item;
    }

    if (fundClassNorm && (fundClassNorm === secClassNorm || fundClassNorm === secAbbrNorm)) {
      return item;
    }
  }

  // Pass 3: Suffix Match (กรณี fund.code ลงท้ายด้วยชื่อ Class ของ SEC เช่น "SCBGOLD-A" กับ Class "A")
  for (const item of itemsOnDate) {
    const secClass = (item.fund_class_name || item.class_abbr_name || item.fund_class || '').trim().toUpperCase();
    if (secClass && (fundCode.endsWith(`-${secClass}`) || fundCode.endsWith(`(${secClass})`) || fundCode.endsWith(` ${secClass}`))) {
      return item;
    }
  }

  // Pass 4: Fallback สำหรับ Single Class Fund (โครงการมี 1 กองใน DB และ SEC คืนมา 1 รายการ)
  if (totalFundsInProj === 1 && itemsOnDate.length === 1) {
    return itemsOnDate[0];
  }

  return null;
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

  const today = new Date().toISOString().split('T')[0];
  const past7Days = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

  const navHistoryList = [];
  let processedCount = 0;
  let unmatchedCount = 0;

  for (const [projId, fundList] of projMap.entries()) {
    processedCount++;
    if (processedCount % 50 === 0 || processedCount === projMap.size) {
      console.log(`⏳ ประมวลผลสำเร็จแล้ว ${processedCount}/${projMap.size} โครงการ...`);
    }

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
      for (const [navDate, itemsOnDate] of secDataByDate.entries()) {
        const matchedItem = findMatchedSecItem(fund, itemsOnDate, fundList.length);

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
        } else {
          unmatchedCount++;
          // สุ่มปริ้นท์ตัวอย่างรายการที่ Match ไม่เจอ 5 รายการแรก เพื่อการตรวจสอบ
          if (unmatchedCount <= 5) {
            console.warn(`⚠️ Match ไม่เจอ [Proj: ${projId} | Code: ${fund.code} | ClassDB: "${fund.fund_class_name}"] SEC Response:`, 
              itemsOnDate.map(i => ({ class_abbr: i.class_abbr_name, class_name: i.fund_class_name, proj_abbr: i.proj_abbr_name }))
            );
          }
        }
      }
    }
  }

  console.log(`\n📊 สรุป: จับคู่ราคา NAV ได้ทั้งหมด ${navHistoryList.length} รายการ (จับคู่ไม่ได้ ${unmatchedCount} รายการ)`);

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
