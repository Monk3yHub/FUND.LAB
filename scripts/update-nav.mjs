import ws from 'ws';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = (() => {
  const raw = process.env.SUPABASE_URL?.trim();
  if (!raw) return raw;
  try {
    return new URL(raw).origin; // เหลือแค่ https://xxxx.supabase.co
  } catch {
    return raw;
  }
})();
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY?.trim(); // service_role key
const SEC_API_KEY = process.env.SEC_API_KEY?.trim();

// ตรวจ env ก่อนเริ่ม จะได้รู้ทันทีว่า secret ขาดตัวไหน
const missing = Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, SEC_API_KEY })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`ไม่พบ environment variable: ${missing.join(', ')}`);
  console.error('เช็คว่าตั้ง secrets ใน GitHub และส่งผ่าน env ใน workflow ครบแล้ว');
  process.exit(1);
}

// สร้าง client พร้อมรองรับ WebSocket สำหรับ Node.js 20
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws },
});

// วันที่ตามเวลาไทย (UTC+7) รูปแบบ YYYY-MM-DD
function dateStr(offsetDays = 0) {
  const ms = Date.now() + 7 * 3600 * 1000 - offsetDays * 24 * 3600 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

async function fetchNav(projId) {
  let notFoundCount = 0;
  const maxDays = 7; // ย้อนหลังสูงสุด 7 วัน เผื่อวันนี้ยังไม่ประกาศ NAV / วันหยุด

  for (let i = 0; i < maxDays; i++) {
    const date = dateStr(i);
    const url = `https://api.sec.or.th/FundDailyInfo/${projId}/dailynav/${date}`;

    const res = await fetch(url, {
      headers: { 'Ocp-Apim-Subscription-Key': SEC_API_KEY },
    });

    // 204 / 404 = วันนั้นไม่มีข้อมูล (วันหยุด หรือยังไม่ประกาศ) ลองวันก่อนหน้า
    if (res.status === 204) continue;
    if (res.status === 404) {
      notFoundCount++;
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`SEC API error ${res.status} for ${projId} ${body.slice(0, 200)}`);
    }

    const text = await res.text();
    if (!text.trim()) continue;
    const raw = JSON.parse(text);
    const item = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    if (!item) continue;

    const nav = item.last_val ?? item.nav ?? item.lastNav;
    if (nav === undefined || nav === null) continue;

    return { nav, navDate: item.nav_date ?? item.navDate ?? date };
  }

  if (notFoundCount === maxDays) {
    throw new Error(
      `SEC API ตอบ 404 ทุกวันสำหรับ ${projId} ให้เช็ค proj_id ในตาราง funds หรือ URL ของ endpoint`
    );
  }
  return null;
}

async function main() {
  const { data: funds, error } = await supabase.from('funds').select('code, proj_id');
  if (error) {
    // error ของ Supabase เป็น object ธรรมดา ต้องแปลงเป็น Error เอง
    throw new Error(
      `Supabase query failed: ${error.message} (code: ${error.code ?? '-'}, hint: ${error.hint ?? '-'})`
    );
  }
  if (!funds?.length) {
    console.log('ไม่มีกองทุนในตาราง funds');
    return;
  }

  let failed = 0;

  for (const fund of funds) {
    try {
      const result = await fetchNav(fund.proj_id);
      if (!result) {
        console.warn(`ยังไม่มีข้อมูล NAV ของ ${fund.code}`);
        continue;
      }

      const { nav, navDate } = result;
      const { error: upsertError } = await supabase
        .from('nav_history')
        .upsert(
          { fund_code: fund.code, nav_date: navDate, nav },
          { onConflict: 'fund_code,nav_date' }
        );

      if (upsertError) {
        failed++;
        console.error(`บันทึก ${fund.code} ไม่สำเร็จ:`, upsertError.message);
      } else {
        console.log(`อัพเดท ${fund.code}: NAV ${nav} (${navDate})`);
      }
    } catch (e) {
      failed++;
      console.error(`ดึง NAV ${fund.code} ไม่สำเร็จ:`, e?.message ?? e);
    }
  }

  if (failed > 0) {
    throw new Error(`มี ${failed} กองทุนที่ทำไม่สำเร็จ`);
  }
}

main().catch((err) => {
  console.error('Script failed:', err?.message ?? err);
  if (!(err instanceof Error)) console.error(JSON.stringify(err, null, 2));
  process.exit(1);
});
