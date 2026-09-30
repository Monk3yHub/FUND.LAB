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

// ฟังก์ชันทำความสะอาดข้อความเพื่อเปรียบเทียบ (ตัดวงเล็บและอักขระพิเศษ)
function cleanCode(str) {
  if (!str) return '';
  return str.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function updateNav() {
  console.log('🚀 เริ่มต้นอัปเดตราคา NAV ครอบคลุมทุก Class 100%...');

  // 1. ดึงกองทุนทั้งหมดใน Supabase
  const { data: funds, error: fundsErr } = await supabase
    .from('funds')
    .select('code, proj_id, fund_class_name');

  if (fundsErr || !funds) {
    throw new Error(`ไม่สามารถอ่านตาราง funds ได้: ${fundsErr?.message}`);
  }

  // 2. จัดกลุ่มกองทุนตาม proj_id เพื่อประหยัดการยิง API
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

  // 3. ดึงราคา NAV จาก SEC API แยกตาม proj_id
  for (const [projId, fundList] of projMap.entries()) {
    const url = `https://api.sec.or.th/FundDailyInfo/${encodeURIComponent(projId)}/NAV/daily/${past30Days}/${today}`;

    try {
      const res = await fetch(url, {
        headers: { 'Ocp-Apim-Subscription-Key': SEC_API_KEY }
      });

      if (!res.ok) continue;
      const secData = await res.json();
      if (!Array.isArray(secData) || secData.length === 0) continue;

      // กรองเฉพาะรายการที่มีราคา NAV จริง
      const validSecItems = secData.filter(item => {
        const rawNav = item.nav ?? item.last_val;
        return rawNav != null && !isNaN(parseFloat(rawNav));
      });

      if (validSecItems.length === 0) continue;

      // จัดกลุ่มรายการ NAV จาก SEC ตามวันที่
      const secDataByDate = new Map();
      for (const item of validSecItems) {
        const date = item.nav_date;
        if (!secDataByDate.has(date)) {
          secDataByDate.set(date, []);
        }
        secDataByDate.get(date).push(item);
      }

      // ดำเนินการจับคู่ NAV ให้กับทุก Fund/Class ภายใต้ proj_id นี้
      for (const fund of fundList) {
        const fundCodeClean = cleanCode(fund.code);
        const fundClassClean = cleanCode(fund.fund_class_name);

        for (const [navDate, itemsOnDate] of secDataByDate.entries()) {
          let matchedItem = null;

          // 🎯 Level 1: Match ตรงตัวกับ fund_class_name หรือ code
          matchedItem = itemsOnDate.find(item => {
            const secClass = (item.fund_class_name || item.class_abbr_name || item.proj_abbr_name || '').trim().toUpperCase();
            return (fund.fund_class_name && secClass === fund.fund_class_name.toUpperCase()) ||
                   (secClass === fund.code.toUpperCase());
          });

          // 🎯 Level 2: Clean Match (ตัดวงเล็บ/อักขระพิเศษออกแล้วเทียบ)
          if (!matchedItem) {
            matchedItem = itemsOnDate.find(item => {
              const secClassClean = cleanCode(item.fund_class_name || item.class_abbr_name || item.proj_abbr_name);
              return (fundClassClean && secClassClean === fundClassClean) ||
                     (secClassClean === fundCodeClean) ||
                     (secClassClean.includes(fundCodeClean) || fundCodeClean.includes(secClassClean));
            });
          }

          // 🎯 Level 3: Project Fallback (หาก SEC ส่ง NAV มาในระดับโครงการ ให้ Class ย่อยดึงไปใช้ได้เลย)
          if (!matchedItem && itemsOnDate.length > 0) {
            matchedItem = itemsOnDate[0];
          }

          if (matchedItem) {
            const navValue = parseFloat(matchedItem.nav ?? matchedItem.last_val);
            navHistoryList.push({
              fund_code: fund.code,
              nav_date: navDate,
              nav: navValue,
              updated_at: new Date().toISOString()
            });
          }
        }
      }

    } catch (err) {
      console.error(`⚠️ เกิดข้อผิดพลาดในการดึง NAV สำหรับ proj_id ${projId}:`, err.message);
    }
  }

  console.log(`📊 รวมรายการ NAV ที่จับคู่สำเร็จเตรียมบันทึก: ${navHistoryList.length} รายการ`);

  // 4. บันทึกลง nav_history
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

updateNav().catch(err => {
  console.error('Update NAV failed:', err);
  process.exit(1);
});
