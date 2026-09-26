/* `npm run demo`: the whole app with a pretend WhatsApp and sample clients.

   Forced, not defaulted: `.env` is loaded too (for the Sarvam key), and it
   says DEMO_MODE=0 and DATA_DIR=./data for real use. Letting those win made
   "demo" start the real WhatsApp and write sample clients into the real list.
   The demo always gets its own folder and never touches Firestore data. */
process.env.DEMO_MODE = "1";
process.env.DATA_STORE = "local";
process.env.DATA_DIR = "./data-demo";
process.env.ADMIN_PASSWORD = "demo";
await import("./server.js");
