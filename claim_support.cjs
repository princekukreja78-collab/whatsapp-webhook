// claim_support.cjs — Insurance Claim Support: helpline numbers + claim guide
// Detects claim intent, looks up customer's insurer, sends personalized help

const { findPoliciesByPhone } = require("./policy_lookup.cjs");

// ── Indian Insurer Directory ────────────────────────────────
const INSURER_DATA = {
  "tata aig": {
    helpline: "1800-266-7780",
    tollfree: true,
    claimEmail: "customersupport@tataaig.com",
    website: "https://www.tataaig.com/motor-insurance/claims",
    appName: "Tata AIG Insurance",
    intimationSteps: [
      "Call helpline 1800-266-7780 (24x7) or use Tata AIG app",
      "Share FIR copy (for theft/accident), driving license, RC copy",
      "Insurer will assign a surveyor within 24 hours",
      "Get vehicle inspected at network garage or surveyor visit"
    ]
  },
  "icici lombard": {
    helpline: "1800-266-9725",
    tollfree: true,
    claimEmail: "customersupport@aborad.com",
    website: "https://www.icicilombard.com/motor-insurance/claims",
    appName: "ICICI Lombard Insurance",
    intimationSteps: [
      "Call 1800-266-9725 (24x7) or use IL TakeCare app",
      "Register claim online at icicilombard.com",
      "Upload FIR, driving license, RC, and photos of damage",
      "Surveyor assigned within 24-48 hours"
    ]
  },
  "hdfc ergo": {
    helpline: "1800-266-0700",
    tollfree: true,
    claimEmail: "motor.claims@hdfcergo.com",
    website: "https://www.hdfcergo.com/claims/motor-claim",
    appName: "HDFC Ergo Insurance",
    intimationSteps: [
      "Call 1800-266-0700 (24x7) or use HDFC Ergo app",
      "Register claim on hdfcergo.com → Claims section",
      "Submit FIR, DL, RC, photos, and repair estimate",
      "Choose cashless (network garage) or reimbursement"
    ]
  },
  "bajaj allianz": {
    helpline: "1800-209-5858",
    tollfree: true,
    claimEmail: "bagaborad@bajajallianz.co.in",
    website: "https://www.bajajallianz.com/motor-insurance/motor-claim.html",
    appName: "Bajaj Allianz Insurance",
    intimationSteps: [
      "Call 1800-209-5858 (24x7) or Caringly Yours app",
      "Intimate claim within 24 hours of incident",
      "Upload accident photos, FIR, DL, RC",
      "Surveyor visit arranged; choose cashless or reimbursement"
    ]
  },
  "new india assurance": {
    helpline: "1800-209-1415",
    tollfree: true,
    claimEmail: "claims@newindia.co.in",
    website: "https://www.newindia.co.in",
    appName: "New India Assurance",
    intimationSteps: [
      "Call 1800-209-1415 or visit nearest branch",
      "Submit claim form with FIR, DL, RC, photos",
      "Surveyor assigned for damage assessment",
      "Repair at authorized workshop for cashless settlement"
    ]
  },
  "sbi general": {
    helpline: "1800-102-1111",
    tollfree: true,
    claimEmail: "customer.care@sbigeneral.in",
    website: "https://www.sbigeneral.in/motor-insurance",
    appName: "SBI General Insurance",
    intimationSteps: [
      "Call 1800-102-1111 (24x7) or register online",
      "Submit claim form, FIR, DL, RC, damage photos",
      "Surveyor assigned within 48 hours",
      "Cashless at 4000+ network garages"
    ]
  },
  "united india": {
    helpline: "1800-425-33-33",
    tollfree: true,
    claimEmail: "claims@uiic.co.in",
    website: "https://www.uiic.co.in",
    appName: "United India Insurance",
    intimationSteps: [
      "Call 1800-425-33-33 or visit nearest branch",
      "File claim form with FIR, DL, RC, photos",
      "Surveyor inspection within 48 hours",
      "Settlement within 30 days of document submission"
    ]
  },
  "oriental insurance": {
    helpline: "1800-11-8485",
    tollfree: true,
    claimEmail: "grievance@orientalinsurance.co.in",
    website: "https://www.orientalinsurance.org.in",
    appName: "Oriental Insurance",
    intimationSteps: [
      "Call 1800-11-8485 or visit nearest branch",
      "Submit claim form, FIR, DL, RC",
      "Surveyor visit for damage assessment",
      "Cashless or reimbursement as per policy"
    ]
  },
  "national insurance": {
    helpline: "1800-345-0330",
    tollfree: true,
    claimEmail: "customer.care@nic.co.in",
    website: "https://www.nationalinsurance.nic.co.in",
    appName: "National Insurance",
    intimationSteps: [
      "Call 1800-345-0330 or contact nearest branch",
      "File claim form with required documents",
      "Surveyor assigned for inspection",
      "Settlement based on surveyor report"
    ]
  },
  "acko": {
    helpline: "1800-266-2256",
    tollfree: true,
    claimEmail: "claims@acko.com",
    website: "https://www.acko.com/claims",
    appName: "ACKO Insurance",
    intimationSteps: [
      "Open ACKO app or call 1800-266-2256",
      "Click 'File a Claim' → upload photos of damage",
      "100% digital process — no paperwork needed",
      "Cashless repair at 15000+ network garages"
    ]
  },
  "digit": {
    helpline: "1800-258-4242",
    tollfree: true,
    claimEmail: "hello@godigit.com",
    website: "https://www.godigit.com/claims",
    appName: "Digit Insurance",
    intimationSteps: [
      "Call 1800-258-4242 or use Digit app",
      "Upload damage photos via app (AI-based assessment)",
      "Doorstep claim inspection available",
      "Cashless at 8000+ network garages"
    ]
  },
  "reliance general": {
    helpline: "1800-102-4088",
    tollfree: true,
    claimEmail: "rgicl.claims@relianceada.com",
    website: "https://www.reliancegeneral.co.in",
    appName: "Reliance General Insurance",
    intimationSteps: [
      "Call 1800-102-4088 (24x7)",
      "Register claim online or via app",
      "Submit FIR, DL, RC, repair estimate, photos",
      "Cashless at 5000+ network garages"
    ]
  },
  "cholamandalam": {
    helpline: "1800-200-5544",
    tollfree: true,
    claimEmail: "customercare@cholams.murugappa.com",
    website: "https://www.cholainsurance.com",
    appName: "Chola MS Insurance",
    intimationSteps: [
      "Call 1800-200-5544 or visit cholainsurance.com",
      "Intimate claim within 24 hours",
      "Submit FIR, DL, RC, photos",
      "Surveyor assigned within 48 hours"
    ]
  },
  "iffco tokio": {
    helpline: "1800-103-5499",
    tollfree: true,
    claimEmail: "support@iffcotokio.co.in",
    website: "https://www.iffcotokio.co.in",
    appName: "IFFCO Tokio Insurance",
    intimationSteps: [
      "Call 1800-103-5499 (24x7)",
      "Register claim at iffcotokio.co.in",
      "Upload documents: FIR, DL, RC, damage photos",
      "Cashless or reimbursement settlement"
    ]
  },
  "royal sundaram": {
    helpline: "1800-568-9999",
    tollfree: true,
    claimEmail: "customercare@royalsundaram.in",
    website: "https://www.royalsundaram.in",
    appName: "Royal Sundaram Insurance",
    intimationSteps: [
      "Call 1800-568-9999 (24x7)",
      "Intimate via app or website",
      "Submit FIR, DL, RC, photos, repair estimate",
      "Cashless at network garages"
    ]
  },
  "magma": {
    helpline: "1800-200-0292",
    tollfree: true,
    claimEmail: "care@magma.co.in",
    website: "https://www.magmahdi.com",
    appName: "Magma HDI Insurance",
    intimationSteps: [
      "Call 1800-200-0292 or visit magmahdi.com",
      "File claim online or via nearest branch",
      "Submit FIR, DL, RC, photos",
      "Surveyor assigned for assessment"
    ]
  }
};

// ── Match insurer from sheet data ───────────────────────────
function findInsurerData(insurerName) {
  if (!insurerName) return null;
  const norm = insurerName.toLowerCase().trim();

  // Direct match
  if (INSURER_DATA[norm]) return { key: norm, ...INSURER_DATA[norm] };

  // Partial match
  for (const [key, data] of Object.entries(INSURER_DATA)) {
    if (norm.includes(key) || key.includes(norm)) return { key, ...data };
    // Match any word
    const words = key.split(" ");
    if (words.some(w => w.length > 3 && norm.includes(w))) return { key, ...data };
  }

  return null;
}

// ── Claim Types & Guides ────────────────────────────────────
const CLAIM_TYPES = {
  accident: {
    label: "Accident / Collision",
    docs: ["FIR / Police Report", "Driving License", "RC (Registration Certificate)", "Photos of damage from all angles", "Repair estimate from garage"],
    tips: ["File FIR within 24 hours", "Don't move the vehicle until photos are taken", "Note down other party's details & vehicle number", "Get witness contact info if possible"]
  },
  theft: {
    label: "Theft / Stolen Vehicle",
    docs: ["FIR from police station", "RC copy", "All sets of car keys", "Insurance policy copy", "Non-traceable certificate from police (after 30 days)"],
    tips: ["File FIR immediately at nearest police station", "Inform insurer within 24 hours", "Don't delay — late intimation can lead to claim rejection", "Keep all original documents safe"]
  },
  flood: {
    label: "Flood / Natural Disaster",
    docs: ["Photos of waterlogged vehicle", "FIR or weather authority report", "RC, DL copies", "Repair estimate"],
    tips: ["DO NOT try to start the engine if water entered", "Tow to nearest garage", "Document water level with photos/video", "Keep all service bills"]
  },
  thirdparty: {
    label: "Third Party Damage",
    docs: ["FIR", "Driving License", "RC", "Other party's details", "Witness statements"],
    tips: ["Note the other vehicle's registration number", "Get witness details at the scene", "File FIR even for minor incidents", "Don't admit fault at the scene"]
  },
  windshield: {
    label: "Windshield / Glass Damage",
    docs: ["Photos of damaged glass", "RC copy", "No FIR needed for glass claims usually"],
    tips: ["Many insurers allow zero-depreciation glass claims", "Some policies have 1 free windshield replacement", "Cashless available at most garages", "No NCB impact for glass-only claims in many policies"]
  }
};

// ── Intent Detection ────────────────────────────────────────
function isClaimRequest(msgText) {
  if (!msgText) return false;
  const t = msgText.toLowerCase().trim();
  return /\b(claim|accident|crash|damage|dent|scratch|stolen|theft|flood|water\s*log|broken|windshield|glass\s*broke|hit|collision|insurance\s*help|claim\s*process|how\s*to\s*claim|file\s*claim|raise\s*claim|lodge\s*claim|report\s*accident|helpline|claim\s*number|claim\s*support)\b/i.test(t);
}

function detectClaimType(msgText) {
  if (!msgText) return null;
  const t = msgText.toLowerCase();
  if (/\b(stol|stolen|theft|chori|missing\s*car|rob)\b/.test(t)) return "theft";
  if (/\b(flood|water|submerge|waterlog|barish|rain)\b/.test(t)) return "flood";
  if (/\b(windshield|glass|crack|stone\s*hit|windscreen)\b/.test(t)) return "windshield";
  if (/\b(third\s*party|other\s*car|dusri\s*gaadi|someone\s*hit)\b/.test(t)) return "thirdparty";
  if (/\b(accident|crash|collision|damage|dent|hit|bump|scratch|repair)\b/.test(t)) return "accident";
  return null; // Unknown — show general guide
}

// ── Message Builders ────────────────────────────────────────
function buildClaimSupportMessage(policies, claimType, msgText) {
  let msg = "";

  if (!policies.length) {
    // No policy found — send generic help
    msg += "🆘 *Insurance Claim Support*\n\n";
    msg += "We couldn't find a policy linked to your number.\n\n";
    msg += "Please share your *Registration Number* or *Policy Number* and we'll help you with the claim process.\n\n";
    msg += "In the meantime, here are the immediate steps:\n\n";
    msg += genericClaimSteps();
    return msg;
  }

  const policy = policies[0]; // Primary policy
  const insurer = findInsurerData(policy.insurer);
  const type = claimType ? CLAIM_TYPES[claimType] : null;

  msg += `🆘 *Insurance Claim Support*\n\n`;
  msg += `📋 Your Policy: ${policy.policyNo || "N/A"}\n`;
  msg += `🚗 Car: ${policy.car}${policy.regNo ? ` (${policy.regNo})` : ""}\n`;
  msg += `🏢 Insurer: ${policy.insurer}\n\n`;

  // Helpline — most important info first
  if (insurer) {
    msg += `📞 *Helpline: ${insurer.helpline}*${insurer.tollfree ? " (Toll Free, 24x7)" : ""}\n`;
    if (insurer.claimEmail) msg += `📧 Email: ${insurer.claimEmail}\n`;
    if (insurer.website) msg += `🌐 Online: ${insurer.website}\n`;
    if (insurer.appName) msg += `📱 App: ${insurer.appName}\n`;
    msg += "\n";
  }

  // Claim type specific guide
  if (type) {
    msg += `━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📌 *${type.label} Claim*\n\n`;

    msg += `📄 *Documents Needed:*\n`;
    type.docs.forEach(d => { msg += `• ${d}\n`; });
    msg += "\n";

    msg += `💡 *Important Tips:*\n`;
    type.tips.forEach(t => { msg += `• ${t}\n`; });
    msg += "\n";
  }

  // Insurer-specific steps
  if (insurer && insurer.intimationSteps) {
    msg += `━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📝 *How to File Claim with ${policy.insurer}:*\n\n`;
    insurer.intimationSteps.forEach((s, i) => { msg += `${i + 1}. ${s}\n`; });
    msg += "\n";
  }

  msg += `━━━━━━━━━━━━━━━━━━━\n`;
  msg += `Need help filing the claim? Just reply here — Team Mr. Car will assist you! 🤝`;

  return msg;
}

function genericClaimSteps() {
  return `*Immediate Steps:*\n` +
    `1️⃣ File FIR at nearest police station (for accident/theft)\n` +
    `2️⃣ Call your insurer's helpline (check policy document)\n` +
    `3️⃣ Take photos of damage from all angles\n` +
    `4️⃣ Don't start the engine if water damage\n` +
    `5️⃣ Keep DL, RC, and policy copy ready\n\n` +
    `Share your *Reg Number* and we'll find your insurer's helpline for you!`;
}

function buildAdminClaimAlert(policy, claimType, msgText) {
  const type = claimType ? CLAIM_TYPES[claimType] : null;
  return `🆘 *CLAIM SUPPORT REQUEST*\n\n` +
    `👤 ${policy?.name || "Unknown"}\n` +
    `📱 ${policy?.phone || "Unknown"}\n` +
    `🚗 ${policy?.car || "Unknown"} (${policy?.regNo || "No Reg"})\n` +
    `🏢 ${policy?.insurer || "Unknown"}\n` +
    `📋 Policy: ${policy?.policyNo || "N/A"}\n` +
    `⚠️ Type: ${type?.label || "General Inquiry"}\n` +
    `💬 Message: ${(msgText || "").slice(0, 300)}\n\n` +
    `⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;
}

// ── Get insurer helpline for quick lookup ───────────────────
function getHelplineByInsurer(insurerName) {
  const data = findInsurerData(insurerName);
  return data ? data.helpline : null;
}

module.exports = {
  isClaimRequest,
  detectClaimType,
  buildClaimSupportMessage,
  buildAdminClaimAlert,
  findInsurerData,
  getHelplineByInsurer,
  INSURER_DATA,
  CLAIM_TYPES
};
