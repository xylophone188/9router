#!/usr/bin/env node
/**
 * Batch score NVIDIA models using Claude as judge
 * Uses sqlite3 CLI + fetch API
 */
import { execSync } from "child_process";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const DB_PATH = "/home/melody/cloud/source-code/github/ai/9router/data/db/data.sqlite";
const BATCH_SIZE = 10;
const PROXY = "http://127.0.0.1:7890";
const proxyAgent = new ProxyAgent(PROXY);

// Global fetch with proxy
globalThis.fetch = (url, opts) => undiciFetch(url, { ...opts, dispatcher: proxyAgent });

function sql(query) {
  return execSync(`sqlite3 -json "${DB_PATH}" "${query.replace(/"/g, '\\"')}"`, { encoding: "utf-8" });
}

function getNvidiaApiKey() {
  const rows = JSON.parse(sql("SELECT data FROM providerConnections WHERE provider='nvidia' AND isActive=1 LIMIT 1"));
  if (!rows.length) throw new Error("No active NVIDIA connection");
  const data = JSON.parse(rows[0].data);
  return data.apiKey || data.providerSpecificData?.apiKey;
}

function getJudgeApiKey() {
  // Use NVIDIA free nemotron as judge (free, same region, no restrictions)
  const rows = JSON.parse(sql("SELECT data FROM providerConnections WHERE provider='nvidia' AND isActive=1 LIMIT 1"));
  if (!rows.length) throw new Error("No active NVIDIA connection");
  const data = JSON.parse(rows[0].data);
  return data.apiKey;
}

async function fetchNvidiaModels(apiKey) {
  const resp = await fetch("https://integrate.api.nvidia.com/v1/models", {
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" }
  });
  if (!resp.ok) throw new Error(`NVIDIA API: ${resp.status}`);
  const data = await resp.json();
  return (data?.data || []).filter(m => !m.type || m.type === "chat" || m.type === "text-generation");
}

async function judgeBatch(models, judgeApiKey) {
  const modelList = models.map((m, i) => `${i+1}. ${m.id} (${m.name || m.id})`).join("\n");
  
  const prompt = `Rate these NVIDIA-hosted LLM models on a scale of 1-100. Return ONLY valid JSON array.

Models:
${modelList}

For each model provide: intelligence, coding, math, value (1-100 each).
Value = capability for free tier (all free, so rate by raw capability).

Return: [{"id":"model-id","intelligence":85,"coding":90,"math":80,"value":95}, ...]`;

  // Use NVIDIA free API for judge (nemotron-49b, free tier)
  const resp = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${judgeApiKey}`
    },
    body: JSON.stringify({
      model: "nvidia/llama-3.3-nemotron-super-49b-v1",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }]
    })
  });
  
  if (!resp.ok) throw new Error(`Judge: ${resp.status} - ${await resp.text()}`);
  const result = await resp.json();
  // NVIDIA/OpenAI compatible format
  const text = result.choices?.[0]?.message?.content || result.content?.[0]?.text || "";
  const jsonMatch = text.match(/\[[\s\S]*?\]/);
  if (!jsonMatch) throw new Error("No JSON in response");
  return JSON.parse(jsonMatch[0]);
}

function saveRankings(rankings) {
  // Clear old NVIDIA rankings
  execSync(`sqlite3 "${DB_PATH}" "DELETE FROM modelRankings WHERE provider='NVIDIA';"`);
  
  // Sort by intelligence descending
  const sorted = [...rankings].sort((a, b) => (b.intelligence || 0) - (a.intelligence || 0));
  const now = new Date().toISOString();
  
  // Insert each ranking
  sorted.forEach((r, idx) => {
    const id = crypto.randomUUID();
    const escaped = (s) => String(s || "").replace(/'/g, "''");
    const query = `INSERT INTO modelRankings(id,modelId,modelName,provider,intelligence,coding,math,value,overallRank,rawData,fetchedAt,createdAt) VALUES('${id}','${escaped(r.modelId)}','${escaped(r.modelName)}','${escaped(r.provider)}',${r.intelligence || 'NULL'},${r.coding || 'NULL'},${r.math || 'NULL'},${r.value || 'NULL'},${idx+1},'${escaped(JSON.stringify(r.rawData || {}))}','${now}','${now}')`;
    execSync(`sqlite3 "${DB_PATH}" "${query.replace(/"/g, '\\"')}"`);
  });
  
  return sorted.length;
}

async function main() {
  console.log("🤖 Batch NVIDIA scoring with Claude judge...\n");
  
  const nvidiaKey = getNvidiaApiKey();
  const judgeKey = getJudgeApiKey();
  
  const models = await fetchNvidiaModels(nvidiaKey);
  console.log(`📦 ${models.length} NVIDIA chat models\n`);
  
  const allScores = [];
  const batches = [];
  for (let i = 0; i < models.length; i += BATCH_SIZE) {
    batches.push(models.slice(i, i + BATCH_SIZE));
  }
  
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    process.stdout.write(`  [${i+1}/${batches.length}] `);
    
    let success = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const scores = await judgeBatch(batch, judgeKey);
        allScores.push(...scores.map(s => ({
          ...s,
          modelName: batch.find(m => m.id === s.id)?.name || s.id,
          provider: "NVIDIA",
          rawData: batch.find(m => m.id === s.id) || {}
        })));
        console.log(`✅ ${scores.length}`);
        success = true;
        break;
      } catch (e) {
        if (attempt === 0) {
          process.stdout.write("retry... ");
          await new Promise(r => setTimeout(r, 3000));
        } else {
          console.log(`❌ ${e.message}`);
        }
      }
    }
    
    // Rate limit delay between batches
    if (i < batches.length - 1) await new Promise(r => setTimeout(r, 2000));
  }
  
  console.log(`\n📈 Scored: ${allScores.length}/${models.length}`);
  
  const saved = saveRankings(allScores);
  console.log(`💾 Saved ${saved} rankings\n`);
  
  // Top 15
  allScores.sort((a, b) => (b.intelligence || 0) - (a.intelligence || 0));
  console.log("🏆 Top 15 by intelligence:");
  allScores.slice(0, 15).forEach((r, i) => {
    console.log(`  ${String(i+1).padStart(2)}. ${r.modelId.padEnd(45)} intel=${String(r.intelligence).padStart(3)} coding=${String(r.coding).padStart(3)} math=${String(r.math).padStart(3)} value=${String(r.value).padStart(3)}`);
  });
}

main().catch(console.error);
