// server.js

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { chromium } from "playwright";
import dotenv from "dotenv";

dotenv.config();

const SECRET = process.env.SECRET;
console.log("Loaded SECRET =", SECRET);

// >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
// REQUIRED CHANGE FOR DEPLOYMENT:
const PORT = process.env.PORT || 3000;
// <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

const MAX_TIME_MS = 3 * 60 * 1000; // 3 minutes

const app = express();
app.use(bodyParser.json({ limit: "2mb" }));

function send(res, code, obj) {
  res.status(code).json(obj);
}

// MAIN ENDPOINT
app.post("/", async (req, res) => {
  if (!req.is("application/json") || typeof req.body !== "object") {
    return send(res, 400, { error: "Invalid JSON" });
  }

  const { email, secret, url } = req.body;

  if (!email || !secret || !url) {
    return send(res, 400, { error: "Missing required fields" });
  }

  // SECRET CHECK
  if (secret !== SECRET) {
    return send(res, 403, { error: "Invalid secret" });
  }

  send(res, 200, { status: "accepted", message: "Processing quiz..." });

  (async () => {
    const deadline = Date.now() + MAX_TIME_MS;
    const browser = await chromium.launch({
  headless: true,
  executablePath: chromium.executablePath()
});


    try {
      let nextUrl = url;

      while (nextUrl && Date.now() < deadline) {
        console.log(`Visiting: ${nextUrl}`);

        const page = await browser.newPage();
        await page.goto(nextUrl, { waitUntil: "networkidle", timeout: 60000 });

        const html = await page.content();

        // ========== 1. Try base64 extraction ==========
        const atobMatch = html.match(/atob\(`([\s\S]*?)`\)/);
        if (atobMatch) {
          try {
            const b64 = atobMatch[1].replace(/\s+/g, "");
            const decoded = Buffer.from(b64, "base64").toString("utf8");

            const jsonMatch = decoded.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);

              if (parsed.answer !== undefined) {
                const submitUrl =
                  (decoded.match(/https?:\/\/[^\s'"]+/) || [])[0] || null;

                if (submitUrl) {
                  const payload = {
                    email,
                    secret,
                    url: nextUrl,
                    answer: parsed.answer,
                  };

                  const resp = await fetch(submitUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                  });

                  const respJson = await resp.json();
                  console.log("Submit response:", respJson);

                  nextUrl = respJson?.url || null;
                  await page.close();
                  continue;
                }
              }
            }
          } catch {}
        }

        // ========== 2. Try table-sum extraction ==========
        const tables = await page.evaluate(() => {
          const result = [];
          document.querySelectorAll("table").forEach((table) => {
            const headers = [...table.querySelectorAll("thead th")].map((h) =>
              h.innerText.trim()
            );
            const rows = [...table.querySelectorAll("tbody tr")].map((tr) =>
              [...tr.querySelectorAll("td")].map((td) => td.innerText.trim())
            );
            result.push({ headers, data: rows });
          });
          return result;
        });

        for (const t of tables) {
          const idx = t.headers.findIndex((h) => /value/i.test(h));
          if (idx >= 0) {
            let sum = 0;
            for (const row of t.data) {
              const num = parseFloat(row[idx].replace(/[^0-9.-]/g, ""));
              if (!isNaN(num)) sum += num;
            }

            console.log("SUM =", sum);

            const submitUrl = await page.evaluate(() => {
              const form = document.querySelector("form");
              if (form?.action) return form.action;
              const links = [...document.querySelectorAll("a")];
              const l = links.find((a) => /submit|answer/i.test(a.innerText));
              return l ? l.href : null;
            });

            if (submitUrl) {
              const payload = {
                email,
                secret,
                url: nextUrl,
                answer: sum,
              };

              const resp = await fetch(submitUrl, {
                method: "POST",
                  headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              });

              const respJson = await resp.json();
              console.log("Submit response:", respJson);

              nextUrl = respJson?.url || null;
              await page.close();
              continue;
            }
          }
        }

        console.log("No method found, stopping.");
        nextUrl = null;
        await page.close();
      }
    } catch (err) {
      console.log("Fatal error:", err);
    } finally {
      await browser.close();
    }
  })();
});

// START SERVER (UPDATED)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
