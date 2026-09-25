/**
 * The WhatsApp connection the rest of the app uses: the real one, or in
 * DEMO_MODE the pretend one. Both export the same names.
 */
import { DEMO_MODE } from "./store/index.js";

const wa = DEMO_MODE ? await import("./mockWhatsapp.js") : await import("./whatsapp.js");

export default wa;
