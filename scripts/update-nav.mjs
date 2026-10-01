import ws from 'ws';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY?.trim();
const SEC_API_KEY = process.env.SEC_API_KEY?.trim();

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SEC_API_KEY) {
  console.error('กรุณาตั้งค่า environment variables ให้ครบถ้วน');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws },
});

// ฟังก์ชันแปลงและล้างชื่อย่อ (ตัดอักขระพิเศษ และแปลง SCBNKY -> SCBNK) — ใช้เป็น fallback การจับคู่
function normalizeCode(str) {
  if (!str) return '';
  let cleaned = str.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.startsWith('SCBNKY')) {
    cleaned = 'SCBNK' + cleaned.slice(6);
  }
  return cleaned;
}

// ✅ ตารางช่วยแปลง code ที่ไม่ตรงกับ fund_class_name จริงของ ก.ล.ต. ให้ตรงด้วยมือ
const SPECIFIC_FUND_MAP = {
  'ASP-VIET': 'ASP-VIET-A',
  'ES-ASIA': 'ES-ASIA-A',
  'ES-EG': 'ES-EG-A',
  'ES-GAINCOME': 'ES-GAINCOME-A',
  'KFHTECH': 'KFHTECH-A',
  'KKP SEMICON-H FUND': 'KKP SEMICON-H',
  'KT-Ashares': 'KT-Ashares-A',
  'KT-ASIAG': 'KT-ASIAG-A',
  'KT-ENERGY': 'KT-ENERGY-A',
  'KT-FINANCE': 'KT-FINANCE-A',
  'KTFIXPLUS': 'KTFIXPLUS-A',
  'KT-HEALTHCARE': 'KT-HEALTHCARE-A',
  'KT-JAPANALL': 'KT-JAPANALL-A',
  'KT-JPFUND': 'KT-JPFUND-A',
  'KT-NASDAQ': 'KT-NASDAQ-A',
  'KT-PRECIOUS': 'KT-PRECIOUS-A',
  'KT-S&P500': 'KT-S&P500-A',
  'KT-SET50': 'KT-SET50-A',
  'KT-TECHNOLOGY': 'KT-TECHNOLOGY-A',
  'KT-US': 'KT-US-A',
  'KTWC-ALPHA': 'KTWC-ALPHA-A',
  'KTWC-GROWTH': 'KTWC-GROWTH-A',
  'KTWC-INCOME': 'KTWC-INCOME-A',
  'KTWC-MODERATE': 'KTWC-MODERATE-A',
  'KT-WEQ': 'KT-WEQ-A',
  'K-US500X': 'K-US500X-A(A)',
  'K-USXNDQ': 'K-USXNDQ-A(A)',
  'SCBCHAFUND': 'SCBCHAA',
  'SCBGOLDFUND': 'SCBGOLD',
  'SCBGOLDHFUND': 'SCBGOLDH',
  'SCBIHEALTH': 'SCBIHEALTH(A)',
  'SCBKEQTGFUND': 'SCBKEQTG',
  'SCBNKY225': 'SCBNK225',
  'SCBS&P500FUND': 'SCBS&P500',
  'SCBSEMI': 'SCBSEMI(A)',
  'TUSHEALTH': 'TUSHEALTH-A',
  'UGSTAR-M': 'UGSTAR',
};

// ============================================================
// ✅ แก้ใหม่: ดึง proj_id -> "รายการ fund ทั้งหมดที่ใช้ proj_id นี้" (ไม่ใช่ตัวเดียวแบบเดิม)
//    เพราะ 1 proj_id อาจมีได้หลาย class/หลาย code ในตาราง funds
// ============================================================
async function getAllFundsMapping() {
  const projIdMap = new Map(); // proj_id -> [{ code, fund_class_name }, ...]
  let page = 0;
  const pageSize = 1000;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('funds')
      .select('code, proj_id, fund_class_name')
      .not('proj_id', 'is', null)
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error) {
      console.error('เกิดข้อผิดพลาดในการดึงข้อมูลตาราง funds:', error.message);
      break;
    }

    if (!data || data.length === 0) {
      hasMore = false;
    } else {
      data.forEach((f) => {
        if (!f.proj_id || !f.code) return;
        const projId = f.proj_id.trim();
        if (!projIdMap.has(projId)) projIdMap.set(projId, []);
        projIdMap.get(projId).push({
          code: f.code.trim(),
          fund_class_name: f.fund_class_name ? f.fund_class_name.trim() : null,
        });
      });
      if (data.length < pageSize) {
        hasMore = false;
      } else {
        page++;
      }
    }
  }

  return projIdMap;
}

// ============================================================
// ✅ แก้ใหม่: จับคู่ item ที่ได้จาก API กับ fund ที่ถูกต้องใน proj_id นั้น โดยใช้ fund_class_name จริง
//    (ของเดิมแค่เจอ proj_id ตรงก็เอาเลย ไม่สนใจ class — นี่คือจุดที่ทำให้ NAV ปนกัน)
// ============================================================
function matchFundForItem(fundList, item) {
  if (!fundList || fundList.length === 0) return null;

  const itemClassRaw = (item.fund_class_name || '').trim();
  const itemClassUpper = itemClassRaw.toUpperCase();
  const itemClassNorm = normalizeCode(itemClassRaw);

  if (fundList.length === 1) {
    // ✅ แก้บั๊ก: เดิมเชื่อว่า "มีแถวเดียวในตาราง funds = ไม่มีทางปนกัน" ซึ่งผิด —
    //    proj_id นี้อาจมีหลาย class จริงในฝั่ง ก.ล.ต. แค่ funds ของเราเก็บแค่ class เดียว
    //    ต้องเช็ค fund_class_name ของ item เทียบกับที่เราคาดไว้ด้วยเสมอ ถ้ามีข้อมูลให้เทียบทั้ง 2 ฝั่ง
    const only = fundList[0];
    const expectedRaw = SPECIFIC_FUND_MAP[only.code] || only.fund_class_name;

    if (!itemClassRaw || !expectedRaw) {
      // ไม่มีข้อมูล class ให้เทียบเลยทั้ง 2 ฝั่ง (กองทุนแบบ single-class แท้ๆ ที่ ก.ล.ต. ไม่ติด tag class) → ยอมรับได้
      return only;
    }

    const expectedUpper = expectedRaw.trim().toUpperCase();
    const expectedNorm = normalizeCode(expectedRaw);
    if (expectedUpper === itemClassUpper || expectedNorm === itemClassNorm) {
      return only;
    }
    // มี class ทั้ง 2 ฝั่งแต่ไม่ตรงกัน → proj_id นี้มีมากกว่า 1 class จริง แต่ funds table เรามีแค่แถวเดียว ข้ามไปดีกว่าเดา
    return null;
  }

  // Step 1: จับคู่ตรงตัวด้วย fund_class_name จริง (ใช้ SPECIFIC_FUND_MAP แทนถ้ามี override)
  let matched = fundList.find((f) => {
    const expected = (SPECIFIC_FUND_MAP[f.code] || f.fund_class_name || '').trim().toUpperCase();
    return expected && itemClassUpper && expected === itemClassUpper;
  });
  if (matched) return matched;

  // Step 2: จับคู่แบบ normalize กันสะกด/เว้นวรรค/ตัวเล็กใหญ่ไม่ตรงเป๊ะ
  matched = fundList.find((f) => {
    const expected = normalizeCode(SPECIFIC_FUND_MAP[f.code] || f.fund_class_name);
    return expected && itemClassNorm && expected === itemClassNorm;
  });
  if (matched) return matched;

  // หาไม่เจอจริงๆ (ไม่รู้ว่า item นี้เป็นของ class ไหนใน proj_id ที่มีหลาย class)
  // ข้ามไปเลยดีกว่าเดา — เดาผิดจะทำให้ NAV ปนกันแบบที่เจอปัญหามาก่อน
  return null;
}

async function updateAllNAV() {
  console.log('1. ดึงรายชื่อกองทุนทั้งหมดจาก Supabase...');
  const projIdMap = await getAllFundsMapping();
  const totalFundCount = [...projIdMap.values()].reduce((s, list) => s + list.length, 0);
  console.log(`โหลดข้อมูลจับคู่สำเร็จ ${projIdMap.size} โครงการ (proj_id) รวม ${totalFundCount} กองทุน/class`);

  if (projIdMap.size === 0) {
    throw new Error('ไม่พบข้อมูลกองทุนในตาราง funds');
  }

  // คำนวณวันที่ย้อนหลัง 7 วันจากปัจจุบัน (ป้องกันติดวันหยุดเสาร์-อาทิตย์)
  // ถ้าต้องการ backfill ช่วงอื่น ตั้ง env var RANGE_START ได้ (YYYY-MM-DD)
  const today = new Date();
  const pastSevenDays = new Date(today);
  pastSevenDays.setDate(today.getDate() - 7);
  const startNavDate = process.env.RANGE_START?.trim() || pastSevenDays.toISOString().split('T')[0];

  console.log(`\n2. ดึงข้อมูล NAV ล่าสุด (ตั้งแต่วันที่ ${startNavDate}) จาก SEC API...`);

  const navRecordsMap = new Map();
  const skippedDetails = new Map(); // proj_id -> { apiClassNames: Set, dbClassNames: Set, dbCodes: Set }
  let nextCursor = '';
  let pageNum = 1;

  do {
    let url = `https://api.sec.or.th/v2/fund/daily-info/nav?page_size=100&start_nav_date=${startNavDate}`;
    if (nextCursor) {
      url += `&next_cursor=${encodeURIComponent(nextCursor)}`;
    }

    const res = await fetch(url, {
      headers: { 'Ocp-Apim-Subscription-Key': SEC_API_KEY },
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`รอบที่ ${pageNum} ตอบกลับสถานะ ${res.status}: ${errText.slice(0, 100)}`);
      break;
    }

    const raw = await res.json();
    const items = Array.isArray(raw) ? raw : (raw.items ?? raw.data ?? []);

    const nextCursorFromBody = raw.next_cursor || raw.nextCursor;
    const nextCursorFromHeader = res.headers.get('x-next-cursor') || res.headers.get('next-cursor') || res.headers.get('next_cursor');
    const prevCursor = nextCursor;
    nextCursor = nextCursorFromBody || nextCursorFromHeader || '';

    let matchedInThisPage = 0;

    items.forEach((item) => {
      const projId = (item.proj_id || item.proj_code || item.unique_id || '').trim();
      if (!projId) return;

      const fundList = projIdMap.get(projId);
      if (!fundList) return;

      // ✅ จุดที่แก้: จับคู่ตาม class จริง ไม่ใช่เอาตัวแรกที่เจอเหมือนเดิม
      const matchedFund = matchFundForItem(fundList, item);
      if (!matchedFund) {
        // เก็บรายละเอียดไว้บอกว่า proj_id นี้ API ส่ง class ชื่ออะไรมา เทียบกับที่เรามีในตาราง funds
        // (บันทึกทุกกรณีที่ข้าม ไม่ใช่แค่ตอน fundList.length > 1 เหมือนเดิม — เคสแถวเดียวก็ข้ามได้แล้วตอนนี้)
        if (!skippedDetails.has(projId)) {
          skippedDetails.set(projId, { apiClassNames: new Set(), dbClassNames: new Set(), dbCodes: new Set() });
        }
        const detail = skippedDetails.get(projId);
        if (item.fund_class_name) detail.apiClassNames.add(item.fund_class_name);
        fundList.forEach((f) => {
          detail.dbCodes.add(f.code);
          detail.dbClassNames.add(SPECIFIC_FUND_MAP[f.code] || f.fund_class_name || '(ไม่มีค่า)');
        });
        return;
      }
      const code = matchedFund.code;

      const navDate = item.nav_date || item.as_of_date || item.date;
      const navVal = parseFloat(item.last_val ?? item.net_asset_value ?? item.nav);

      if (navDate && navDate >= startNavDate && !isNaN(navVal) && navVal > 0) {
        const key = `${code}_${navDate}`;
        // ไม่ต้องกัน "ตัวแรกชนะ" อีกแล้ว เพราะตอนนี้จับคู่ถูก class แน่นอนแล้ว ถ้าซ้ำคือข้อมูลเดียวกันจริง
        navRecordsMap.set(key, {
          fund_code: code,
          nav_date: navDate,
          nav: navVal,
        });
        matchedInThisPage++;
      }
    });

    console.log(`- รอบที่ ${pageNum}: รับข้อมูลมา ${items.length} รายการ (บันทึก NAV สำเร็จ ${matchedInThisPage} รายการ)`);
    pageNum++;

    if (items.length === 0 || (nextCursor && nextCursor === prevCursor)) {
      break;
    }

  } while (nextCursor);

  const navRecords = Array.from(navRecordsMap.values());
  console.log(`\nสรุป: รวบรวมข้อมูล NAV ได้รวม ${navRecords.length} รายการ`);
  if (skippedDetails.size > 0) {
    console.log(`\n⚠️ มี ${skippedDetails.size} โครงการ (proj_id) ที่ข้ามไปเพราะหา class ที่ตรงไม่เจอ รายละเอียด:`);
    for (const [projId, detail] of skippedDetails.entries()) {
      console.log(`  - proj_id ${projId}`);
      console.log(`      โค้ดในตาราง funds: ${[...detail.dbCodes].join(', ')}`);
      console.log(`      ค่าที่ใช้จับคู่อยู่ตอนนี้ (fund_class_name/SPECIFIC_FUND_MAP): ${[...detail.dbClassNames].join(' | ')}`);
      console.log(`      ค่า fund_class_name จริงที่ API ส่งมา: ${[...detail.apiClassNames].join(' | ') || '(ไม่มีค่าในรายการที่ข้าม)'}`);
    }
  }

  if (navRecords.length === 0) {
    console.log('ไม่พบข้อมูล NAV ล่าสุดที่ต้องบันทึก');
    return;
  }

  // 3. บันทึกลง Supabase
  console.log('\n3. บันทึกข้อมูลลงตาราง nav_history ใน Supabase...');
  const chunkSize = 500;
  let insertedCount = 0;

  for (let i = 0; i < navRecords.length; i += chunkSize) {
    const chunk = navRecords.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('nav_history')
      .upsert(chunk, { onConflict: 'fund_code,nav_date' });

    if (error) {
      console.error(`เกิดข้อผิดพลาดในการบันทึกชุดที่ ${i}:`, error.message);
    } else {
      insertedCount += chunk.length;
    }
  }

  console.log(`\nบันทึกข้อมูล NAV ลง nav_history สำเร็จทั้งหมด ${insertedCount} รายการ!`);
}

updateAllNAV().catch((err) => {
  console.error('Update NAV Failed:', err?.message ?? err);
  process.exit(1);
});
