/**
 * Pluto AI Platform - Backend (Node.js)
 * Purpose: General-purpose AI Research & Synthesis Engine.
 * Logic: Scrapes AI share links, synthesizes context, and enables interactive chat.
 * Concurrency Fix: Implemented Singleton Browser pattern to handle multiple users simultaneously.
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

// Global browser instance for concurrency management
let globalBrowser = null;

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
 * Get or launch the shared browser instance.
 * This ensures that multiple users share one browser process (saving RAM).
 */
async function getBrowser() {
    if (globalBrowser && globalBrowser.isConnected()) {
        return globalBrowser;
    }
    const chromePath = resolveChromePath();
    globalBrowser = await puppeteer.launch({ 
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
    return globalBrowser;
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
        .replace(/Terms of Service|Privacy Policy|Cookie Preferences|Report conversation|By messaging ChatGPT|Check important info|Sign in|Explore our other|Try Gemini|Try ChatGPT|Verify you are human/gi, "")
        .replace(/[^\x20-\x7E\n]/g, " ") 
        .trim()
        .substring(0, 18000);
}

/**
 * Surgical Scraper - Uses browser tabs for concurrency efficiency
 */
async function extractConversationData(url) {
    let page;
    try {
        const browser = await getBrowser();
        console.log(`[Pluto Scraper] Opening tab for: ${url}`);
        
        // Open a new tab (page) instead of a new browser
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Auto-scroll to trigger lazy-loaded messages
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                let distance = 100;
                let timer = setInterval(() => {
                    let scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if(totalHeight >= scrollHeight){
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        });

        await new Promise(r => setTimeout(r, 5000));

        const result = await page.evaluate(() => {
            const selectors = [
                '.markdown', '.message-content', '.model-response-text',
                'div[data-message-author-role]', 'article', '.p-4.md\\:p-6',
                '.conversation-container', 'div[class*="message"]', 'div[class*="content"]', 'main' 
            ];
            
            let data = [];
            selectors.forEach(s => {
                document.querySelectorAll(s).forEach(el => {
                    const txt = el.innerText.trim();
                    if (txt.length > 60) data.push(txt);
                });
            });
            
            return {
                content: data.join('\n\n---\n\n'),
                title: document.title
            };
        });
        
        await page.close(); // Close the tab, but keep browser running
        const final = sanitizeScrapedContent(result.content);
        
        if (final.length < 150) {
            return `DATA_ERROR: Could not find content bubbles on "${result.title}".`;
        }
        
        return `[SOURCE: ${result.title}]\n\n${final}`;
    } catch (e) {
        if (page) await page.close();
        return `DATA_ERROR: ${e.message}`;
    }
}

/**
 * API: Initialize Session (Standard or Research)
 */
app.post('/api/initialize', async (req, res) => {
    const { links, title } = req.body;
    console.log(`[Pluto] Init Session: ${title}`);
    
    try {
        let foundation = "";
        
        if (links && links.length > 0) {
            const transcripts = await Promise.all(
                links.filter(l => l.url).map(l => extractConversationData(l.url))
            );
            
            const validData = transcripts.filter(t => !t.startsWith("DATA_ERROR")).join('\n\n');

            if (validData.length < 200) {
                const errorLog = transcripts.find(t => t.startsWith("DATA_ERROR")) || "No content found.";
                throw new Error(`Extraction Failed: ${errorLog}`);
            }

            const result = await callLlamaWithRetry([
                { 
                    role: "system", 
                    content: `You are Pluto Intelligence, an elite research synthesizer developed by Spectrum SyntaX. 

Guidelines:
1. IDENTITY: You were created by Spectrum SyntaX. No cap.
2. PERSONALITY: Use a subtle Gen Z mix (phrases like "locked in," "cook," or "W logic") ONLY for the introductory or concluding remarks. 
3. TECHNICAL CLARITY: For the actual "Technical Synthesis" and "Master Briefing," you must drop all slang. Use high-level, clear, academic, and professional English. 
4. FOCUS: Ignore all metadata, platform warnings, or boilerplate. 
5. FORMAT: Use bold headers and clean bullet points. ALWAYS use clean Markdown tables for comparisons.` 
                },
                { 
                    role: "user", 
                    content: `TRANSCRIPTS FOR ANALYSIS:\n${validData}\n\nCORE TOPIC: ${title}\n\nTASK: Synthesize the knowledge and include a clear comparison table.` 
                }
            ]);
            foundation = result.choices?.[0]?.message?.content;
        } 
        else {
            const result = await callLlamaWithRetry([
                { 
                    role: "system", 
                    content: "You are Pluto, an advanced AI knowledge engine developed by Spectrum SyntaX. Greet the user with a Gen Z mix (e.g., 'locked in', 'ready to cook'). If asked about your origins, mention Spectrum SyntaX. Ensure technical explanations are professional." 
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
        console.error(`[Pluto Error] ${error.message}`);
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
                content: `You are Pluto Intelligence, an AI developed by Spectrum SyntaX. Ground your responses in the foundation: \n\n${foundation}\n\nPersona: Gen Z slang for vibes/greetings only. Professional for content. Mention Spectrum SyntaX if asked about origins.` 
            },
            { 
                role: "user", 
                content: `KNOWLEDGE FOUNDATION: \n\n${foundation}\n\nUSER QUERY: ${lastMsg}` 
            }
        ]);
        res.json({ success: true, reply: result.choices?.[0]?.message?.content });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Pluto Backend Active on port ${PORT}`));