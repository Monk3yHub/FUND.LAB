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

async function syncAllFunds() {
  console.log('1. กำลังดึงรายชื่อ บลจ. ทั้งหมดจาก SEC API (/v2/fund/general-info/amcs)...');

  // 1. ดึงรายชื่อ บลจ. จาก Endpoint amcs
  const amcUrl = 'https://api.sec.or.th/v2/fund/general-info/amcs';
  const amcRes = await fetch(amcUrl, {
    headers: { 'Ocp-Apim-Subscription-Key': SEC_API_KEY },
  });

  if (!amcRes.ok) {
    const errText = await amcRes.text().catch(() => '');
    throw new Error(`ดึงข้อมูล AMCs ไม่สำเร็จ Status: ${amcRes.status} - ${errText.slice(0, 100)}`);
  }

  const amcs = await amcRes.json();
  const amcList = Array.isArray(amcs) ? amcs : (amcs.items ?? amcs.data ?? []);
  console.log(`พบ บลจ. ในระบบทั้งหมด ${amcList.length} แห่ง`);

  if (amcList.length > 0) {
    console.log('ตัวอย่างข้อมูล บลจ. แรก:', JSON.stringify(amcList[0]));
  }

  // 2. ดึงข้อมูลโปรไฟล์กองทุนจาก Endpoint profiles
  console.log('\n2. กำลังดึงข้อมูลโปรไฟล์กองทุนจาก SEC API (/v2/fund/general-info/profiles)...');
  const profilesUrl = 'https://api.sec.or.th/v2/fund/general-info/profiles';
  const profRes = await fetch(profilesUrl, {
    headers: { 'Ocp-Apim-Subscription-Key': SEC_API_KEY },
  });

  if (!profRes.ok) {
    const errText = await profRes.text().catch(() => '');
    throw new Error(`ดึง Profiles ไม่สำเร็จ Status: ${profRes.status} - ${errText.slice(0, 100)}`);
  }

  const rawProfiles = await profRes.json();
  const items = Array.isArray(rawProfiles) ? rawProfiles : (rawProfiles.items ?? rawProfiles.data ?? []);

  console.log(`ดึงข้อมูลกองทุนได้ทั้งหมด ${items.length} รายการ`);

  const uniqueFundsMap = new Map();

  items.forEach((item, idx) => {
    const projId = item.proj_id || item.proj_code || item.unique_id;
    if (!projId) return;

    const rawCode = item.proj_abbr_name || item.unique_id || item.proj_id || item.sym_code || `FUND_${idx}`;
    const code = String(rawCode).trim();
    const rawName = item.proj_name_th || item.proj_name_en || item.proj_abbr_name || code;
    const name = String(rawName).trim();

    if (!uniqueFundsMap.has(code)) {
      uniqueFundsMap.set(code, {
        proj_id: String(projId).trim(),
        code: code,
        name: name,
      });
    }
  });

  const uniqueFunds = Array.from(uniqueFundsMap.values());
  console.log(`คัดกรองเตรียมบันทึกลง Supabase: ${uniqueFunds.length} รายการ`);

  // 3. บันทึกลง Supabase
  const chunkSize = 200;
  let insertedCount = 0;

  for (let i = 0; i < uniqueFunds.length; i += chunkSize) {
    const chunk = uniqueFunds.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('funds')
      .upsert(chunk, { onConflict: 'code' });

    if (error) {
      console.error(`เกิดข้อผิดพลาดในการบันทึกชุดที่ ${i}:`, error.message);
    } else {
      insertedCount += chunk.length;
    }
  }

  console.log(`\nบันทึกรายชื่อกองทุนลง Supabase เรียบร้อยแล้วทั้งหมด ${insertedCount} กองทุน!`);
}

syncAllFunds().catch((err) => {
  console.error('Sync failed:', err?.message ?? err);
  process.exit(1);
});
