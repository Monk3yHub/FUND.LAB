import ws from 'ws';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY?.trim();
const SEC_API_KEY = process.env.SEC_API_KEY?.trim();

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ กรุณาตั้งค่า SUPABASE_URL และ SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws },
});

async function auditAllFunds() {
  console.log('🔍 กำลังเริ่มตรวจสอบกองทุนทั้งหมดในระบบเทียบกับ SEC...\n');

  const { data: funds, error } = await supabase.from('funds').select('*');
  if (error || !funds) {
    console.error('❌ ไม่สามารถอ่านตาราง funds ได้:', error?.message);
    process.exit(1);
  }

  let problemCount = 0;

  for (const fund of funds) {
    const fundCode = fund.code || fund.fund_code;
    const projId = fund.proj_id || fundCode;

    if (!fundCode) continue;

    const url = `https://api.sec.or.th/FundDailyInfo/${encodeURIComponent(projId)}/NAV/daily/2026-01-01/2026-09-30`;
    try {
      const res = await fetch(url, {
        headers: { 'Ocp-Apim-Subscription-Key': SEC_API_KEY || '' }
      });

      if (!res.ok) {
        console.log(`⚠️ [ERROR API] กองทุน ${fundCode} (proj_id: ${projId}) ยิง SEC ไม่ผ่าน`);
        continue;
      }

      const secData = await res.json();
      if (!Array.isArray(secData) || secData.length === 0) {
        console.log(`⚠️ [NO DATA] กองทุน ${fundCode} ไม่มีข้อมูลใน SEC`);
        continue;
      }

      const secClasses = [...new Set(secData.map(item => item.proj_abbr_name?.trim().toUpperCase()))];
      const isMatched = secClasses.includes(fundCode.trim().toUpperCase());

      if (!isMatched) {
        problemCount++;
        console.log(`❌ [ชื่อไม่ตรง] กองทุนใน DB: '${fundCode}' (proj_id: ${projId})`);
        console.log(`   👉 Class ที่ SEC มีจริงในโครงการนี้: [ ${secClasses.join(', ')} ]\n`);
      }
    } catch (err) {
      console.error(`⚠️ Exception for ${fundCode}:`, err.message);
    }
  }

  if (problemCount === 0) {
    console.log('✅ สมบูรณ์แบบ! กองทุนทั้งหมดในระบบมีชื่อตรงกับ Class ของ SEC 100%');
  } else {
    console.log(`⚠ พบทั้งหมด ${problemCount} กองทุนที่มีปัญหาชื่อไม่ตรงกับ SEC`);
  }
}

auditAllFunds();
