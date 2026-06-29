import "dotenv/config";
import fs from "fs";
import path from "path";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-east-1",
  ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
    },
  } : {}),
});

const CLAUDE_MODEL_ID = process.env.BEDROCK_CLAUDE_MODEL || "anthropic.claude-3-5-sonnet-20241022-v2:0";

const targetFiles = [
  "server.ts",
  "src/server/db.ts",
  "src/server/queues.ts",
  "src/server/liveStockData.ts",
  "src/server/mcApiService.ts",
  "src/server/companyProfileSyncService.ts",
  "src/services/aiService.ts",
  "src/services/bedrockService.ts",
  "src/services/geminiService.ts",
];

const targetDirs = [
  "src/server/routers",
];

async function getReviewFiles(): Promise<string[]> {
  const files: string[] = [];
  
  // Add direct files if they exist
  for (const f of targetFiles) {
    if (fs.existsSync(f)) {
      files.push(f);
    }
  }
  
  // Add directory files
  for (const dir of targetDirs) {
    if (fs.existsSync(dir)) {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && (item.endsWith(".ts") || item.endsWith(".tsx"))) {
          files.push(fullPath);
        }
      }
    }
  }
  
  return files;
}

async function reviewFile(filePath: string): Promise<string> {
  const content = fs.readFileSync(filePath, "utf-8");
  console.log(`[REVIEW] Querying Claude (Bedrock) to review: ${filePath}...`);
  
  const systemPrompt = `You are a principal software engineer and security auditor.
Analyze the provided source file and provide a structured codebase review report focusing on:
1. **Critical Vulnerabilities & Security Risks** (e.g. credential leakage, unvalidated inputs, auth gaps)
2. **Database Inefficiencies & Resource Leaks** (e.g. unclosed connections, N+1 query patterns, lack of indexing, casting errors)
3. **Logic Gaps & Missing Error Handling** (e.g. unhandled API exceptions, silent failures, unsafe type assertions)
4. **Architectural Improvements & Code Quality** (e.g. redundant code, hardcoded config, violation of DRY/SOLID principles)

Keep your observations specific, actionable, and reference actual line contents or code patterns where possible. If there are no issues in a category, skip it. Keep descriptions direct and concise.`;

  const prompt = `Review the following source file: "${filePath}"

SOURCE CODE:
\`\`\`typescript
${content}
\`\`\``;

  try {
    const command = new ConverseCommand({
      modelId: CLAUDE_MODEL_ID,
      messages: [{ role: "user", content: [{ text: prompt }] }],
      system: [{ text: systemPrompt }],
      inferenceConfig: {
        maxTokens: 2000,
        temperature: 0.1,
      },
    });
    
    const response = await client.send(command);
    const resultText = response.output?.message?.content?.[0]?.text;
    if (!resultText) {
      return `### File: ${filePath}\n\n*Error: Empty response returned by model.*`;
    }
    
    return `## File: [${path.basename(filePath)}](file:///${path.resolve(filePath).replace(/\\/g, "/")})\n\n${resultText}`;
  } catch (error: any) {
    console.error(`[ERROR] Failed to review file ${filePath}:`, error.message);
    return `## File: [${path.basename(filePath)}](file:///${path.resolve(filePath).replace(/\\/g, "/")})\n\n*Error running review: ${error.message}*`;
  }
}

async function run() {
  console.log("[START] Starting Amazon Bedrock Codebase Review...");
  const files = await getReviewFiles();
  console.log(`[FILES] Identified ${files.length} files for review.`);
  
  let reportContent = `# Codebase Review Report (via Amazon Bedrock Claude 3.5 Sonnet)

**Date:** ${new Date().toLocaleDateString()}
**AWS Bedrock Model:** \`${CLAUDE_MODEL_ID}\`

This report compiles security, database, logic, and code quality evaluations conducted on the core backend and service files.

---\n\n`;

  for (const file of files) {
    const review = await reviewFile(file);
    reportContent += review + "\n\n---\n\n";
    // Add small delay to prevent rate limits
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  
  const docsDir = path.resolve("docs");
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }
  
  const reportPath = path.join(docsDir, "codebase_review_report.md");
  fs.writeFileSync(reportPath, reportContent, "utf-8");
  console.log(`[SUCCESS] Codebase review report generated at: ${reportPath}`);
}

run().catch(console.error);
