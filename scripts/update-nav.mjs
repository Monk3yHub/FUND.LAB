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

async function updateNav() {
  console.log('🚀 เริ่มต้นอัปเดตราคา NAV แบบตรวจสอบ Class 100%...');

  // 1. ดึงกองทุนทั้งหมดใน Supabase
  const { data: funds, error: fundsErr } = await supabase
    .from('funds')
    .select('code, proj_id, fund_class_name');

  if (fundsErr || !funds) {
    throw new Error(`ไม่สามารถอ่านตาราง funds ได้: ${fundsErr?.message}`);
  }

  // 2. จัดกลุ่มตาม proj_id เพื่อลดจำนวนการยิง API
  const projMap = new Map();
  for (const fund of funds) {
    if (!fund.proj_id) continue;
    if (!projMap.has(fund.proj_id)) {
      projMap.set(fund.proj_id, []);
    }
    projMap.get(fund.proj_id).push(fund);
  }

  const today = new Date().toISOString().split('T')[0];
  const past30Days = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

  const navHistoryList = [];
  const latestNavList = [];

  // 3. ยิง API SEC แยกตาม proj_id
  for (const [projId, fundList] of projMap.entries()) {
    const url = `https://api.sec.or.th/FundDailyInfo/${encodeURIComponent(projId)}/NAV/daily/${past30Days}/${today}`;

    try {
      const res = await fetch(url, {
        headers: { 'Ocp-Apim-Subscription-Key': SEC_API_KEY }
      });

      if (!res.ok) continue;
      const secData = await res.json();
      if (!Array.isArray(secData) || secData.length === 0) continue;

      for (const fund of fundList) {
        // กำหนด Class Target ที่ต้องจับคู่ให้ตรง
        const targetClass = (fund.fund_class_name || fund.code).trim().toUpperCase();

        // 🎯 EXACT MATCH: กรองเอาเฉพาะอันที่ proj_abbr_name ตรงกับ Class ของเราเป๊ะๆ เท่านั้น!
        const matchedItems = secData.filter(item => {
          const secClass = (item.proj_abbr_name || '').trim().toUpperCase();
          return secClass === targetClass && item.nav != null;
        });

        if (matchedItems.length === 0) continue;

        // เรียงตามวันที่
        matchedItems.sort((a, b) => new Date(a.nav_date) - new Date(b.nav_date));

        // ใส่ navHistoryList
        for (const item of matchedItems) {
          navHistoryList.push({
            fund_code: fund.code,
            nav_date: item.nav_date,
            nav: parseFloat(item.nav),
            updated_at: new Date().toISOString()
          });
        }

        // รายการล่าสุดใส่ latestNavList
        const latestItem = matchedItems[matchedItems.length - 1];
        latestNavList.push({
          fund_code: fund.code,
          nav_date: latestItem.nav_date,
          nav: parseFloat(latestItem.nav),
          updated_at: new Date().toISOString()
        });
      }

    } catch (err) {
      console.error(`⚠️ Error fetching NAV for proj_id ${projId}:`, err.message);
    }
  }

  console.log(`📊 พบรายการ NAV ที่จับคู่ Class ถูกต้องทั้งหมด ${navHistoryList.length} รายการ`);

  // 4. บันทึกลง nav_history
  if (navHistoryList.length > 0) {
    const chunkSize = 500;
    for (let i = 0; i < navHistoryList.length; i += chunkSize) {
      const chunk = navHistoryList.slice(i, i + chunkSize);
      await supabase.from('nav_history').upsert(chunk, { onConflict: 'fund_code,nav_date' });
    }
  }

  // 5. บันทึกลง latest_nav
  if (latestNavList.length > 0) {
    const chunkSize = 500;
    for (let i = 0; i < latestNavList.length; i += chunkSize) {
      const chunk = latestNavList.slice(i, i + chunkSize);
      await supabase.from('latest_nav').upsert(chunk, { onConflict: 'fund_code' });
    }
  }

  console.log('🎉 อัปเดตราคา NAV เรียบร้อยแล้ว!');
}

updateNav().catch(err => {
  console.error('Update NAV failed:', err);
  process.exit(1);
});
