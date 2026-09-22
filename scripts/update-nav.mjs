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

// 1. ดึง mapping proj_id -> code ทั้งหมดจาก Supabase
async function getAllFundsMapping() {
  const projIdToCodeMap = new Map();
  let page = 0;
  const pageSize = 1000;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('funds')
      .select('code, proj_id')
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
        if (f.proj_id && f.code) {
          projIdToCodeMap.set(f.proj_id.trim(), f.code.trim());
        }
      });
      if (data.length < pageSize) {
        hasMore = false;
      } else {
        page++;
      }
    }
  }

  return projIdToCodeMap;
}

async function updateAllNAV() {
  console.log('1. ดึงรายชื่อกองทุนทั้งหมดจาก Supabase (เพื่อจับคู่ proj_id -> fund_code)...');
  const projIdToCodeMap = await getAllFundsMapping();
  console.log(`โหลดข้อมูลจับคู่สำเร็จทั้งหมด ${projIdToCodeMap.size} กองทุน`);

  if (projIdToCodeMap.size === 0) {
    throw new Error('ไม่พบข้อมูลกองทุนในตาราง funds');
  }

  console.log('\n2. ดึงข้อมูล NAV จาก SEC API (/v2/fund/daily-info/nav)...');

  const navRecordsMap = new Map();
  let nextCursor = '';
  let pageNum = 1;

  do {
    // ใช้ Endpoint ที่ถูกต้องตรงตามการทดสอบในหน้าเว็บ
    let url = 'https://api.sec.or.th/v2/fund/daily-info/nav?page_size=100';
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

      const code = projIdToCodeMap.get(projId);
      if (!code) return;

      const navDate = item.nav_date || item.as_of_date || item.date;
      // ดึงค่า NAV จาก last_val ตามโครงสร้าง JSON จริง
      const navVal = parseFloat(item.last_val ?? item.net_asset_value ?? item.nav);

      if (navDate && !isNaN(navVal)) {
        const key = `${code}_${navDate}`;
        if (!navRecordsMap.has(key)) {
          navRecordsMap.set(key, {
            fund_code: code,
            nav_date: navDate,
            nav: navVal,
          });
          matchedInThisPage++;
        }
      }
    });

    console.log(`- รอบที่ ${pageNum}: รับข้อมูลมา ${items.length} รายการ (จับคู่ NAV สำเร็จ ${matchedInThisPage} รายการ)`);
    pageNum++;

    if (items.length === 0 || (nextCursor && nextCursor === prevCursor)) {
      break;
    }

  } while (nextCursor);

  const navRecords = Array.from(navRecordsMap.values());
  console.log(`\nสรุป: รวบรวมข้อมูล NAV ทั้งหมดได้รวม ${navRecords.length} รายการ`);

  if (navRecords.length === 0) {
    console.log('ไม่พบข้อมูล NAV ที่สามารถแมตช์บันทึกได้');
    return;
  }

  // 3. บันทึกลง Supabase ตาราง nav_history
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
