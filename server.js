/**
 * Pluto AI Platform - Backend (Node.js)
 * Purpose: General-purpose AI Research & Synthesis Engine.
 * Logic: Scrapes AI share links, synthesizes context, and enables interactive chat.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); 
const puppeteer = require('puppeteer'); 
const fs = require('fs');
const { execSync } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const LLAMA_API_KEY = process.env.LLAMA_API_KEY;
const LLAMA_MODEL = process.env.LLAMA_MODEL || "llama-3.3-70b-versatile";
const LLAMA_API_URL = process.env.LLAMA_API_URL || "https://api.groq.com/openai/v1/chat/completions";

/**
 * Resolve Chrome Path for Render/Docker environment
 */
function resolveChromePath() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    const dockerPath = '/usr/bin/google-chrome-stable';
    if (fs.existsSync(dockerPath)) return dockerPath;
    try {
        const dynamicPath = execSync('which google-chrome-stable || which google-chrome || which chromium').toString().trim();
        if (dynamicPath && fs.existsSync(dynamicPath)) return dynamicPath;
    } catch (e) {}
    return dockerPath;
}

/**
 * AI Call with Exponential Backoff
 */
async function callLlamaWithRetry(messages, retries = 5) {
    const defaultDelays = [1000, 2000, 4000, 8000, 16000];
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(LLAMA_API_URL, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${LLAMA_API_KEY}`
                },
                body: JSON.stringify({ 
                    model: LLAMA_MODEL, 
                    messages, 
                    temperature: 0.7, 
                    max_tokens: 8192 
                })
            });
            const result = await response.json();
            if ((response.status === 429 || response.status === 503) && i < retries - 1) {
                await new Promise(res => setTimeout(res, defaultDelays[i]));
                continue;
            }
            if (!response.ok) throw new Error(result.error?.message || `API Error: ${response.status}`);
            return result;
        } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(res => setTimeout(res, defaultDelays[i]));
        }
    }
}

/**
 * Scrub legal boilerplate from scraped text
 */
function sanitizeScrapedContent(text) {
    if (!text) return "";
    return text
        .replace(/Terms of Service|Privacy Policy|Cookie Preferences|Report conversation|By messaging ChatGPT|Check important info|Sign in|Google|Explore our other|Try Gemini|Try ChatGPT|Verify you are human/gi, "")
        .replace(/[^\x20-\x7E\n]/g, " ") 
        .trim()
        .substring(0, 18000);
}

/**
 * Aggressive SPA Scraper for AI Platforms
 */
async function extractConversationData(url) {
    let browser;
    try {
        const chromePath = resolveChromePath();
        console.log(`[Pluto Scraper] Extracting Link: ${url}`);
        
        browser = await puppeteer.launch({ 
            executablePath: chromePath,
            headless: "new", 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', 
                '--no-zygote', 
                '--single-process'
            ] 
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        // Hard wait for JS-heavy AI bubbles to render
        await new Promise(r => setTimeout(r, 12000));

        const result = await page.evaluate(() => {
            const selectors = [
                '.markdown', 
                '.message-content', 
                '.model-response-text',
                'div[data-message-author-role]',
                'article',
                '.p-4.md\\:p-6',
                '.conversation-container',
                'div[class*="message"]',
                'main' 
            ];
            
            let data = [];
            selectors.forEach(s => {
                document.querySelectorAll(s).forEach(el => {
                    const txt = el.innerText.trim();
                    if (txt.length > 50) data.push(txt);
                });
            });
            
            return {
                content: data.join('\n\n---\n\n'),
                title: document.title
            };
        });
        
        await browser.close();
        const final = sanitizeScrapedContent(result.content);
        
        if (final.length < 200) {
            return `DATA_ERROR: Failed to extract meaningful content from "${result.title}". Link might be private or blocked.`;
        }
        
        return `[SOURCE: ${result.title}]\n\n${final}`;
    } catch (e) {
        if (browser) await browser.close();
        return `DATA_ERROR: ${e.message}`;
    }
}

/**
 * API: Initialize Session (Standard or Research)
 */
app.post('/api/initialize', async (req, res) => {
    const { links, title } = req.body;
    console.log(`[Pluto] Init: ${title}`);
    
    try {
        let foundation = "";
        
        // Research Mode
        if (links && links.length > 0) {
            const transcripts = await Promise.all(
                links.filter(l => l.url).map(l => extractConversationData(l.url))
            );
            
            const validData = transcripts.filter(t => !t.startsWith("DATA_ERROR")).join('\n\n');

            if (validData.length < 300) {
                throw new Error("Could not extract enough data from links. Ensure they are public share links.");
            }

            const result = await callLlamaWithRetry([
                { 
                    role: "system", 
                    content: `You are Pluto Intelligence, an elite research synthesizer. You were created by Spectrum SyntaX. Your goal is to combine multiple AI conversations into a single, high-level intelligence report. 

Guidelines:
1. IDENTITY: If asked who made you or created you, explicitly state that you were developed by Spectrum SyntaX.
2. FOCUS: Ignore all metadata, platform warnings, dates, or legal boilerplate. 
3. CONTENT: Deeply analyze the core discussion. What is each source trying to explain or teach?
4. STRUCTURE: Provide a "Technical Synthesis" section that merges the information from all sources into a cohesive narrative.
5. MASTER BRIEFING: Provide a structured "Master Briefing" that acts as a definitive guide for the user to learn and master the topic efficiently.
6. NO META-INFO: Do not include a "Comparative Analysis" section, and do NOT include notes or post-scripts at the end about which tool provided which information. Provide a unified, seamless knowledge foundation.
7. FORMAT: Use bold headers and clean bullet points. Maintain a direct, technical, and objective tone.` 
                },
                { 
                    role: "user", 
                    content: `TRANSCRIPTS FOR ANALYSIS:\n${validData}\n\nCORE TOPIC: ${title}\n\nTASK: Provide a unified content summary and master briefing. Ignore meta-info about the tools or the process.` 
                }
            ]);
            foundation = result.choices?.[0]?.message?.content;
        } 
        // Standard Chat Mode
        else {
            const result = await callLlamaWithRetry([
                { 
                    role: "system", 
                    content: "You are Pluto, an advanced AI knowledge engine developed by Spectrum SyntaX. Greet the user to their new session professionally. State that you are online and ready to assist with any topic or query. If asked about your origins, mention Spectrum SyntaX." 
                },
                { 
                    role: "user", 
                    content: `SESSION TITLE: ${title}` 
                }
            ]);
            foundation = result.choices?.[0]?.message?.content;
        }
        
        res.json({ success: true, foundation });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * API: Interactive Chat
 */
app.post('/api/chat', async (req, res) => {
    const { foundation, history } = req.body;
    try {
        const lastMsg = history[history.length - 1].content;
        const result = await callLlamaWithRetry([
            { 
                role: "system", 
                content: `You are Pluto Intelligence, an AI developed by Spectrum SyntaX. Ground your responses in the following knowledge foundation: \n\n${foundation}\n\nIf the user asks about your creator or origins, state that you were created by Spectrum SyntaX. Be intelligent, direct, and professional.` 
            },
            { 
                role: "user", 
                content: lastMsg 
            }
        ]);
        res.json({ success: true, reply: result.choices?.[0]?.message?.content });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Pluto Backend Active on port ${PORT}`));