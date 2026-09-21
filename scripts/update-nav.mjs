import ws from 'ws';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // service_role key
const SEC_API_KEY = process.env.SEC_API_KEY;

// สร้าง client พร้อมรองรับ WebSocket สำหรับ Node.js 20
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws }
});

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function fetchNav(projId) {
  const today = todayStr();
  const res = await fetch(
    `https://api.sec.or.th/FundDailyInfo/${projId}/dailynav/${today}/${today}`,
    { headers: { 'Ocp-Apim-Subscription-Key': SEC_API_KEY } }
  );
  if (!res.ok) throw new Error(`SEC API error ${res.status} for ${projId}`);
  const data = await res.json();
  
  const latest = Array.isArray(data) ? data[data.length - 1] : data;
  return { nav: latest.nav ?? latest.lastNav, navDate: latest.nav_date ?? latest.navDate ?? today };
}

async function main() {
  const { data: funds, error } = await supabase.from('funds').select('code, proj_id');
  if (error) throw error;

  for (const fund of funds) {
    try {
      const { nav, navDate } = await fetchNav(fund.proj_id);
      const { error: upsertError } = await supabase
        .from('nav_history')
        .upsert(
          { fund_code: fund.code, nav_date: navDate, nav },
          { onConflict: 'fund_code,nav_date' }
        );
      if (upsertError) console.error(`บันทึก ${fund.code} ไม่สำเร็จ:`, upsertError.message);
      else console.log(`อัพเดท ${fund.code}: NAV ${nav} (${navDate})`);
    } catch (e) {
      console.error(`ดึง NAV ${fund.code} ไม่สำเร็จ:`, e.message);
    }
  }
}

main();
