/* `npm run demo`: the whole app with a pretend WhatsApp and sample clients.
   Set here rather than on the command line so it works the same on Windows. */
process.env.DEMO_MODE ??= "1";
await import("./server.js");
