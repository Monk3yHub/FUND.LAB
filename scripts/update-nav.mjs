import ws from 'ws';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
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
  const to = dateStr(0);
  const from = dateStr(7); // ย้อนหลัง 7 วัน เผื่อวันนี้ยังไม่ประกาศ NAV / วันหยุด
  const url = `https://api.sec.or.th/FundDailyInfo/${projId}/dailynav/${from}/${to}`;

  const res = await fetch(url, {
    headers: { 'Ocp-Apim-Subscription-Key': SEC_API_KEY },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SEC API error ${res.status} for ${projId} ${body.slice(0, 200)}`);
  }

  const raw = await res.json();
  const list = (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
  if (list.length === 0) return null;

  // เรียงตามวันที่ แล้วเอาตัวล่าสุด
  const rows = list
    .map((r) => ({
      nav: r.nav ?? r.lastNav ?? r.last_val,
      navDate: r.nav_date ?? r.navDate ?? to,
    }))
    .filter((r) => r.nav !== undefined && r.nav !== null)
    .sort((a, b) => String(a.navDate).localeCompare(String(b.navDate)));

  return rows.length ? rows[rows.length - 1] : null;
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
