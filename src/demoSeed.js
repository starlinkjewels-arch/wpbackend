/**
 * Sample data for DEMO_MODE: a believable B2B diamond-jewellery client book,
 * so every screen has something on it the first time someone opens the demo.
 * Never runs against a real database.
 */
import { contacts, campaigns, dailyStats, settingsCol } from "./data/collections.js";
import { writeRecipients } from "./data/recipients.js";
import { logMessage } from "./data/inbox.js";
import { DEFAULTS } from "./data/settings.js";
import { dayKey } from "./engine/rules.js";

const PEOPLE = [
  ["Yosef Katz", "Katz Diamonds Ltd", "972521234567", "IL", "Ramat Gan", ["VIP", "Wholesaler"], { Budget: "$250k", "Preferred Metal": "Platinum" }],
  ["Ahmed Al Mansoori", "Al Mansoori Jewellers", "971501234567", "AE", "Dubai", ["VIP", "Retailer", "Dubai Expo 2026"], { Budget: "$120k", "Preferred Metal": "18K Yellow Gold" }],
  ["Linda Chen", "Golden Lotus Jewelry", "85291234567", "HK", "Hong Kong", ["Hong Kong Show", "Retailer"], { Budget: "$80k", "Preferred Metal": "18K White Gold" }],
  ["Pieter Janssens", "Janssens & Zoon BV", "32470123456", "BE", "Antwerp", ["Wholesaler"], { Budget: "$300k" }],
  ["Michael Goldberg", "Goldberg Fine Jewelry", "12125550147", "US", "New York", ["VIP", "Retailer"], { Budget: "$150k", "Preferred Metal": "Platinum" }],
  ["Sarah Thompson", "Thompson Bridal", "447911123456", "GB", "London", ["Retailer", "Bridal"], { "Preferred Metal": "18K Rose Gold" }],
  ["Omar Farouk", "Farouk Gold & Diamonds", "971552345678", "AE", "Sharjah", ["Retailer", "Dubai Expo 2026"], {}],
  ["Wei Zhang", "Shenzhen Luxe Trading", "8613800138000", "CN", "Shenzhen", ["Wholesaler", "Hong Kong Show"], { Budget: "$500k" }],
  ["Rachel Levi", "Levi Gems", "972541112233", "IL", "Tel Aviv", ["Wholesaler"], {}],
  ["Khalid Al Rashid", "Rashid Jewellery House", "966501234567", "SA", "Riyadh", ["VIP", "Retailer"], { Budget: "$200k", "Preferred Metal": "18K Yellow Gold" }],
  ["Emma Dubois", "Maison Dubois", "33612345678", "FR", "Paris", ["Retailer", "Bridal"], {}],
  ["Takeshi Sato", "Sato Bijoux", "819012345678", "JP", "Tokyo", ["Retailer"], {}],
  ["Anna Rossi", "Rossi Gioielli", "393312345678", "IT", "Milan", ["Retailer"], { "Preferred Metal": "18K White Gold" }],
  ["David Cohen", "Cohen Brothers Diamonds", "12125550199", "US", "New York", ["Wholesaler", "VIP"], { Budget: "$400k" }],
  ["Fatima Hassan", "Pearl & Stone Qatar", "97433123456", "QA", "Doha", ["Retailer"], {}],
  ["Somchai Wong", "Bangkok Gem House", "66812345678", "TH", "Bangkok", ["Wholesaler"], {}],
  ["Lucas Weber", "Weber Schmuck", "4915112345678", "DE", "Munich", ["Retailer"], {}],
  ["Priya Nair", "Nair Jewels Singapore", "6591234567", "SG", "Singapore", ["Retailer", "Hong Kong Show"], {}],
  ["James Wilson", "Wilson & Co", "61412345678", "AU", "Sydney", ["Retailer"], {}],
  ["Hassan Karimi", "Karimi Trading LLC", "971509998000", "AE", "Dubai", ["Wholesaler"], {}],
  ["", "Diamond Hub FZE", "971561234567", "AE", "Dubai", ["Dubai Expo 2026"], {}],
  ["Mr. Alan Brooks", "Brooks Heritage", "447700123456", "GB", "Birmingham", ["Retailer"], {}],
];

export async function seedDemo() {
  if (contacts.size) return;
  const now = Date.now();
  const tz = DEFAULTS.timezone;

  await settingsCol.put("app", { ...DEFAULTS, minDelay: 4, maxDelay: 9, window: { ...DEFAULTS.window, enabled: false } });

  await contacts.putMany(
    PEOPLE.map(([name, company, phone, country, city, tags, fields], i) => ({
      id: phone, phone, name, company, email: "", country, city, tags, notes: "", fields,
      optedOut: i === 15, waStatus: phone.endsWith("000") ? "invalid" : "valid",
      source: i < 19 ? "import" : "manual", createdAt: now - (30 - i) * 86400000, updatedAt: now - i * 3600000,
    })),
  );

  // Two enquiries that arrived on their own.
  const inquiries = [
    ["971585551234", "Rashid Traders", "Hi, do you supply GIA certified solitaires 1ct+? Need price for 20 pcs."],
    ["85298887777", "Mandy Lau", "Saw your post. Please send your latest catalogue."],
  ];
  for (const [phone, name, text] of inquiries) {
    await contacts.put(phone, {
      phone, name, company: "", email: "", country: phone.startsWith("971") ? "AE" : "HK", city: "", tags: ["Inquiry"],
      notes: "", fields: {}, optedOut: false, waStatus: "valid", source: "inbound",
      createdAt: now - 2 * 3600000, updatedAt: now - 2 * 3600000, lastMessageAt: now - 2 * 3600000,
    });
    await logMessage({ phone, dir: "in", text, at: now - 2 * 3600000, name });
  }

  // A finished campaign, with replies in the inbox.
  const done = PEOPLE.slice(0, 12);
  await writeRecipients("cdemo1", done.map(([n, , p], i) => ({
    p, n, s: i === 7 ? "failed" : "sent", t: now - 3 * 86400000 + i * 20000, ...(i === 7 ? { e: "Not on WhatsApp" } : null),
  })));
  await campaigns.put("cdemo1", {
    name: "New Bridal Collection", status: "completed", materialized: true, chunkCount: 1,
    message: "{Hello|Hi|Dear} {{first_name|Sir/Madam}},\n\nOur *new bridal collection* is here — solitaire rings and eternity bands with GIA certified diamonds.\n\nReply *YES* for the catalogue and B2B prices.\n\n— {{business_name}}",
    mediaId: null, audience: { mode: "all", tags: [], tagMatch: "any", contactIds: [], excludeTags: [] },
    minDelay: 12, maxDelay: 30, scheduledAt: now - 3 * 86400000,
    stats: { total: 12, pending: 0, sent: 11, failed: 1, skipped: 0 },
    createdAt: now - 4 * 86400000, updatedAt: now - 3 * 86400000, startedAt: now - 3 * 86400000, finishedAt: now - 3 * 86400000 + 300000,
  });
  const replies = [
    ["971501234567", "Ahmed Al Mansoori", "YES please send. Also need 2ct oval pieces."],
    ["972521234567", "Yosef Katz", "Interested. What are your rates for VS1 G colour?"],
    ["12125550147", "Michael Goldberg", "Please share videos of the eternity bands"],
  ];
  for (const [i, [phone, name, text]] of replies.entries()) {
    await logMessage({ phone, dir: "out", text: "Our new bridal collection is here — reply YES for the catalogue.", at: now - 3 * 86400000, name, campaignId: "cdemo1" });
    await logMessage({ phone, dir: "in", text, at: now - (20 - i * 6) * 3600000, name });
  }

  await campaigns.put("cdemo2", {
    name: "Dubai Expo invite", status: "scheduled", materialized: false,
    message: "Dear {{first_name|Sir/Madam}},\n\nWe will be at *Dubai Jewellery Expo 2026*. Visit us at Hall 3, Booth D-12 to see our new high-jewellery line.\n\nReply to book a private viewing.",
    mediaId: null, audience: { mode: "tags", tags: ["Dubai Expo 2026"], tagMatch: "any", contactIds: [], excludeTags: [] },
    minDelay: 12, maxDelay: 30, scheduledAt: now + 26 * 3600000, stats: null,
    createdAt: now - 3600000, updatedAt: now - 3600000,
  });
  await campaigns.put("cdemo3", {
    name: "Diwali greetings", status: "draft", materialized: false,
    message: "{Warm|Best} Diwali wishes to you and the {{company|team}} family from all of us at {{business_name}} ✨",
    mediaId: null, audience: { mode: "all", tags: [], tagMatch: "any", contactIds: [], excludeTags: [] },
    minDelay: 12, maxDelay: 30, scheduledAt: null, stats: null, createdAt: now - 7200000, updatedAt: now - 7200000,
  });

  const daily = [];
  for (let i = 13; i >= 0; i -= 1) {
    const sent = i === 3 ? 11 : Math.round(Math.max(0, 18 * Math.sin(i / 2) + 14 + ((i * 7) % 9)));
    daily.push({ id: dayKey(now - i * 86400000, tz), sent, failed: i % 4 === 0 ? 1 : 0, inbound: Math.round(sent / 5) + (i % 3), newContacts: i % 5 === 0 ? 2 : 0 });
  }
  daily[daily.length - 1] = { ...daily[daily.length - 1], sent: 0, failed: 0, inbound: 2, newContacts: 2 };
  await dailyStats.putMany(daily.map((d) => ({ ...d, date: d.id })));
  console.log("[demo] sample data loaded");
}
