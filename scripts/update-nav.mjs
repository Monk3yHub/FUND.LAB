import ws from 'ws';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = (() => {
  const raw = process.env.SUPABASE_URL?.trim();
  if (!raw) return raw;
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
})();
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY?.trim();
const SEC_API_KEY = process.env.SEC_API_KEY?.trim();

// ตรวจ env ก่อนเริ่ม
const missing = Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, SEC_API_KEY })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`ไม่พบ environment variable: ${missing.join(', ')}`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws },
});

async function fetchNav(projId) {
  // ส่งแค่ proj_id API v2 จะส่งข้อมูล NAV วันล่าสุดกลับมาให้อัตโนมัติ
  const url = `https://api.sec.or.th/v2/fund/daily-info/nav?proj_id=${projId}`;

  const res = await fetch(url, {
    headers: { 'Ocp-Apim-Subscription-Key': SEC_API_KEY },
  });

  if (res.status === 204 || res.status === 404) return null;

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SEC API error ${res.status} for ${projId} ${body.slice(0, 200)}`);
  }

  const text = await res.text();
  if (!text.trim()) return null;

  const raw = JSON.parse(text);
  const items = raw.items ?? (Array.isArray(raw) ? raw : []);
  const item = items[items.length - 1] ?? items[0];
  if (!item) return null;

  const nav = item.last_val ?? item.nav ?? item.lastNav;
  if (nav === undefined || nav === null) return null;

  return { nav, navDate: item.nav_date ?? item.navDate };
}

async function main() {
  const { data: funds, error } = await supabase.from('funds').select('code, proj_id');
  if (error) {
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
  process.exit(1);
});
