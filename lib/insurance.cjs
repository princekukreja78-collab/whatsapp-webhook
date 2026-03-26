// lib/insurance.cjs — Insurance enquiry flow
// Handles: fresh (new car), used car (with inspection), renewal
// Collects details → forwards to insurance group → follows up → sends quote to customer

const fs = require('fs');
const path = require('path');

let _config = {};

// Per-customer insurance state
const insuranceState = new Map(); // phone → { stage, data }

function init(config) {
  _config = config;
  // Follow-up check every 15 minutes
  setInterval(_checkFollowUps, 15 * 60 * 1000);
}

// ==================== COVERAGE EXPLANATIONS ====================

const COVERAGE_EXPLAIN = {
  thirdParty:
    `*Third Party (TP)* — Mandatory by law\n` +
    `Covers: Damage you cause to others (people, vehicles, property)\n` +
    `Does NOT cover: Your own car damage, theft, fire\n` +
    `Best for: Old cars (10+ years), very tight budget\n` +
    `Cost: Lowest (fixed by IRDAI)`,

  comprehensive:
    `*Comprehensive* — Most Popular\n` +
    `Covers: Everything TP covers + your own car (accident, theft, fire)\n` +
    `Does NOT cover: Wear & tear, mechanical breakdown, consumables\n` +
    `Best for: Most car owners, daily use cars\n` +
    `Cost: Moderate`,

  zeroDep:
    `*0 Dep + Consumables + Engine Cover* — Full Protection\n` +
    `Covers: Everything Comprehensive covers PLUS:\n` +
    `• *Zero Depreciation* — full claim without depreciation deduction on parts\n` +
    `• *Consumables* — engine oil, brake fluid, AC gas, nuts/bolts, bearings\n` +
    `• *Engine Cover* — engine damage due to water ingression, oil leakage\n` +
    `Best for: New cars, expensive cars, peace of mind\n` +
    `Cost: Highest but best value for cars under 5 years`,

  rti:
    `*Return to Invoice (RTI)*\n` +
    `Covers: Full invoice value of the car in case of total loss or theft\n` +
    `Without RTI: You get only depreciated value (IDV)\n` +
    `With RTI: You get what you originally paid\n\n` +
    `*Important:* RTI continues for up to *6 years* if renewed without break.\n` +
    `If you break the chain (even 1 day gap), RTI benefit is lost permanently.\n` +
    `Best for: New cars in first 5-6 years`,

  ncb:
    `*No Claim Bonus (NCB)*\n` +
    `Discount you earn for each claim-free year:\n` +
    `• 1st year: 20%\n` +
    `• 2nd year: 25%\n` +
    `• 3rd year: 35%\n` +
    `• 4th year: 45%\n` +
    `• 5th year+: 50% (maximum)\n\n` +
    `*If you make a claim, NCB resets to 0%*\n` +
    `*If policy lapses (>90 days gap), NCB is lost*\n\n` +
    `Tip: For small damages, pay out of pocket to protect your NCB.`
};

// ==================== ENTRY POINT ====================

async function startInsurance(from) {
  insuranceState.set(from, {
    stage: 'ASK_TYPE',
    data: {},
    startedAt: new Date().toISOString()
  });

  _config.setLastService(from, 'INS_ASK_TYPE');

  const buttons = [
    { type: 'reply', reply: { id: 'INS_NEW', title: 'New Car' } },
    { type: 'reply', reply: { id: 'INS_USED', title: 'Used Car' } },
    { type: 'reply', reply: { id: 'INS_RENEWAL', title: 'Renewal' } }
  ];

  await _config.waSendRaw({
    messaging_product: 'whatsapp', to: from, type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: '*Insurance Service*\n\nWhat type of insurance do you need?' },
      action: { buttons }
    }
  });

  return true;
}

// ==================== MESSAGE HANDLER ====================

async function handleMessage(from, msgText, selectedId) {
  const state = insuranceState.get(from);
  if (!state) return false;

  const text = (msgText || '').trim();
  const id = selectedId || text;

  switch (state.stage) {
    case 'ASK_TYPE':
      return await _handleType(from, id, state);
    case 'ASK_CAR_DETAILS':
      return await _handleCarDetails(from, text, state);
    case 'ASK_LAST_POLICY':
      return await _handleLastPolicy(from, text, state);
    case 'ASK_CLAIM_HISTORY':
      return await _handleClaimHistory(from, id, state);
    case 'ASK_COVERAGE':
      return await _handleCoverage(from, id, state);
    case 'ASK_CUSTOMER_DETAILS':
      return await _handleCustomerDetails(from, text, state);
    case 'CONFIRM':
      return await _handleConfirm(from, id, state);
    case 'WAITING_QUOTE':
      // Customer asking about status
      await _config.waSendText(from,
        'Your insurance quote is being processed. We\'ll get back to you shortly with the best options.'
      );
      return true;
    default:
      return false;
  }
}

// ==================== STAGE HANDLERS ====================

async function _handleType(from, id, state) {
  if (id === 'INS_NEW') {
    state.data.type = 'New Car';
    state.data.needsInspection = false;
  } else if (id === 'INS_USED') {
    state.data.type = 'Used Car (Transfer/Fresh)';
    state.data.needsInspection = true;
  } else if (id === 'INS_RENEWAL') {
    state.data.type = 'Renewal';
    state.data.needsInspection = false;
  } else {
    await _config.waSendText(from, 'Please select: New Car, Used Car, or Renewal.');
    return true;
  }

  state.stage = 'ASK_CAR_DETAILS';
  _config.setLastService(from, 'INS_CAR');
  insuranceState.set(from, state);

  let msg = `*${state.data.type}*\n\nPlease share your car details:\n\n`;
  if (state.data.type === 'New Car') {
    msg += `• Car model & variant\n• Invoice copy (photo) — if available`;
  } else {
    msg += `• *Car registration number* (e.g., DL01AB1234)\n• OR send *RC copy* photo\n`;
    if (state.data.type === 'Renewal') {
      msg += `• *Last policy copy* (photo/PDF)`;
    }
  }

  await _config.waSendText(from, msg);
  return true;
}

async function _handleCarDetails(from, text, state) {
  // Extract car number if present
  const regMatch = text.match(/[A-Z]{2}\s*\d{1,2}\s*[A-Z]{1,3}\s*\d{1,4}/i);
  if (regMatch) {
    state.data.regNumber = regMatch[0].toUpperCase().replace(/\s+/g, '');
  }
  state.data.carDetails = text;

  // If renewal, ask for last policy
  if (state.data.type === 'Renewal') {
    state.stage = 'ASK_LAST_POLICY';
    _config.setLastService(from, 'INS_POLICY');
    insuranceState.set(from, state);

    await _config.waSendText(from,
      'Please share your *last policy copy* (photo or PDF).\n\n' +
      '_If you don\'t have it, just type the policy number or insurer name._'
    );
    return true;
  }

  // For new/used, skip to coverage
  state.stage = 'ASK_COVERAGE';
  _config.setLastService(from, 'INS_COVERAGE');
  insuranceState.set(from, state);
  await _sendCoverageOptions(from);
  return true;
}

async function _handleLastPolicy(from, text, state) {
  state.data.lastPolicy = text;
  state.stage = 'ASK_CLAIM_HISTORY';
  _config.setLastService(from, 'INS_CLAIM');
  insuranceState.set(from, state);

  // Ask about claims for NCB
  const buttons = [
    { type: 'reply', reply: { id: 'INS_NO_CLAIM', title: 'No Claims' } },
    { type: 'reply', reply: { id: 'INS_HAD_CLAIM', title: 'Had Claim(s)' } },
    { type: 'reply', reply: { id: 'INS_NOT_SURE', title: 'Not Sure' } }
  ];

  await _config.waSendRaw({
    messaging_product: 'whatsapp', to: from, type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: '*Claim History*\n\n' +
          'Did you make any claims in your last policy year?\n\n' +
          '_This affects your No Claim Bonus (NCB) discount._'
      },
      action: { buttons }
    }
  });
  return true;
}

async function _handleClaimHistory(from, id, state) {
  if (id === 'INS_NO_CLAIM' || id.toLowerCase() === 'no') {
    state.data.claimHistory = 'No claims — NCB to continue';
  } else if (id === 'INS_HAD_CLAIM' || id.toLowerCase() === 'yes') {
    state.data.claimHistory = 'Had claim(s) — NCB may reset';
  } else if (id === 'INS_NOT_SURE') {
    state.data.claimHistory = 'Not sure — to verify';
  } else {
    state.data.claimHistory = id;
  }

  state.stage = 'ASK_COVERAGE';
  _config.setLastService(from, 'INS_COVERAGE');
  insuranceState.set(from, state);
  await _sendCoverageOptions(from);
  return true;
}

async function _sendCoverageOptions(from) {
  const buttons = [
    { type: 'reply', reply: { id: 'INS_COV_TP', title: 'Third Party' } },
    { type: 'reply', reply: { id: 'INS_COV_COMP', title: 'Comprehensive' } },
    { type: 'reply', reply: { id: 'INS_COV_FULL', title: '0 Dep + Engine' } }
  ];

  await _config.waSendRaw({
    messaging_product: 'whatsapp', to: from, type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: '*Choose Insurance Coverage:*\n\n' +
          '• *Third Party* — Basic (mandatory)\n' +
          '• *Comprehensive* — Own damage + theft + fire\n' +
          '• *0 Dep + Engine* — Full protection with consumables\n\n' +
          '_Not sure? Reply *EXPLAIN* for a simple comparison._'
      },
      action: { buttons }
    }
  });
}

async function _handleCoverage(from, id, state) {
  // Handle EXPLAIN request
  if (/\b(explain|difference|compare|samjhao|batao|kya hai)\b/i.test(id)) {
    let explanation = `*Insurance Coverage — Simple Guide*\n\n`;
    explanation += COVERAGE_EXPLAIN.thirdParty + `\n\n---\n\n`;
    explanation += COVERAGE_EXPLAIN.comprehensive + `\n\n---\n\n`;
    explanation += COVERAGE_EXPLAIN.zeroDep + `\n\n---\n\n`;
    explanation += COVERAGE_EXPLAIN.ncb + `\n\n---\n\n`;
    explanation += COVERAGE_EXPLAIN.rti;

    await _config.waSendText(from, explanation);
    await _config.waSendText(from, 'Now please select your coverage:');
    await _sendCoverageOptions(from);
    return true;
  }

  // Handle RTI question specifically
  if (/\b(rti|return to invoice)\b/i.test(id)) {
    await _config.waSendText(from, COVERAGE_EXPLAIN.rti);
    await _sendCoverageOptions(from);
    return true;
  }

  // Handle NCB question
  if (/\b(ncb|no claim|bonus)\b/i.test(id)) {
    await _config.waSendText(from, COVERAGE_EXPLAIN.ncb);
    await _sendCoverageOptions(from);
    return true;
  }

  if (id === 'INS_COV_TP' || /third\s*party/i.test(id)) {
    state.data.coverage = 'Third Party Only';
  } else if (id === 'INS_COV_COMP' || /comprehensive/i.test(id)) {
    state.data.coverage = 'Comprehensive';
  } else if (id === 'INS_COV_FULL' || /0\s*dep|zero\s*dep|full|engine/i.test(id)) {
    state.data.coverage = '0 Dep + Consumables + Engine Cover';
  } else {
    await _config.waSendText(from, 'Please select: Third Party, Comprehensive, or 0 Dep + Engine.\n\nOr reply *EXPLAIN* for details.');
    return true;
  }

  state.stage = 'ASK_CUSTOMER_DETAILS';
  _config.setLastService(from, 'INS_DETAILS');
  insuranceState.set(from, state);

  await _config.waSendText(from,
    '*Almost done!*\n\nPlease share:\n\n' +
    '• *Full name*\n' +
    '• *Email ID* (for policy link)\n' +
    '• *Mobile number* (if different from this)\n\n' +
    '_Example: Rahul Sharma, rahul@gmail.com, 9876543210_'
  );
  return true;
}

async function _handleCustomerDetails(from, text, state) {
  // Extract email
  const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/i);
  if (emailMatch) state.data.email = emailMatch[0];

  // Extract phone
  const phoneMatch = text.match(/[6-9]\d{9}/);
  if (phoneMatch) state.data.phone = phoneMatch[0];

  // Name — first part before comma or email
  const namePart = text.replace(/[\w.-]+@[\w.-]+\.\w+/g, '').replace(/[6-9]\d{9}/g, '').replace(/[,]/g, ' ').trim();
  if (namePart.length >= 2) state.data.customerName = namePart;

  if (!state.data.email) state.data.email = '-';
  if (!state.data.phone) state.data.phone = from;
  if (!state.data.customerName) state.data.customerName = namePart || 'Customer';

  // Show summary and confirm
  state.stage = 'CONFIRM';
  _config.setLastService(from, 'INS_CONFIRM');
  insuranceState.set(from, state);

  let summary = `*Insurance Enquiry Summary:*\n\n`;
  summary += `Type: *${state.data.type}*\n`;
  summary += `Coverage: *${state.data.coverage}*\n`;
  if (state.data.regNumber) summary += `Reg No: *${state.data.regNumber}*\n`;
  summary += `Car: *${state.data.carDetails || '-'}*\n`;
  summary += `Name: *${state.data.customerName}*\n`;
  summary += `Email: *${state.data.email}*\n`;
  summary += `Phone: *${state.data.phone}*\n`;
  if (state.data.claimHistory) summary += `Claims: *${state.data.claimHistory}*\n`;
  summary += `\nReply *YES* to submit or *NO* to cancel.`;

  await _config.waSendText(from, summary);
  return true;
}

async function _handleConfirm(from, id, state) {
  const reply = (id || '').toLowerCase().trim();

  if (reply === 'no' || reply === 'n' || reply === 'cancel') {
    insuranceState.delete(from);
    _config.setLastService(from, '');
    await _config.waSendText(from, 'Insurance enquiry cancelled. Type *hi* for the menu.');
    return true;
  }

  if (reply !== 'yes' && reply !== 'y') {
    await _config.waSendText(from, 'Please reply *YES* to submit or *NO* to cancel.');
    return true;
  }

  // Submit — forward to insurance group
  state.stage = 'WAITING_QUOTE';
  state.data.submittedAt = new Date().toISOString();
  state.data.followUpCount = 0;
  _config.setLastService(from, 'INS_WAITING');
  insuranceState.set(from, state);

  await _config.waSendText(from,
    '*Insurance enquiry submitted!*\n\n' +
    'Our team is getting the best quotes for you.\n' +
    'You\'ll receive the options shortly during working hours (10am-7pm, Mon-Sat).'
  );

  // Forward to insurance group/admin
  await _forwardToInsuranceGroup(from, state.data);

  return true;
}

// ==================== GROUP FORWARDING ====================

async function _forwardToInsuranceGroup(from, data) {
  // Send to insurance group or admin
  const insuranceGroup = (process.env.INSURANCE_GROUP_WA || _config.ADMIN_WA || '').trim();
  if (!insuranceGroup) {
    console.warn('Insurance: no INSURANCE_GROUP_WA or ADMIN_WA set');
    return;
  }

  let msg = `*Insurance Quote Request*\n\n`;
  msg += `Type: *${data.type}*\n`;
  msg += `Coverage: *${data.coverage}*\n`;
  if (data.regNumber) msg += `Reg No: *${data.regNumber}*\n`;
  msg += `Car: *${data.carDetails || '-'}*\n`;
  if (data.claimHistory) msg += `Claim History: *${data.claimHistory}*\n`;
  msg += `\nCustomer: *${data.customerName}*\n`;
  msg += `Email: *${data.email}*\n`;
  msg += `Phone: *${data.phone}*\n`;
  if (data.lastPolicy) msg += `Last Policy: ${data.lastPolicy}\n`;
  msg += `\n_Please share the best quote. Customer is waiting._`;

  await _config.waSendText(insuranceGroup, msg);
  console.log(`Insurance: forwarded to ${insuranceGroup} for ${from}`);
}

// ==================== FOLLOW-UP ====================

function _isWorkingHours() {
  const now = new Date();
  const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes()) + 330;
  const istHour = Math.floor((istMinutes % 1440) / 60);
  const istDay = istMinutes >= 1440 ? (now.getUTCDay() + 1) % 7 : now.getUTCDay();
  if (istDay === 0) return false;
  return istHour >= 10 && istHour < 19;
}

async function _checkFollowUps() {
  if (!_isWorkingHours()) return;
  if (!_config.waSendText) return;

  const insuranceGroup = (process.env.INSURANCE_GROUP_WA || _config.ADMIN_WA || '').trim();
  if (!insuranceGroup) return;

  for (const [phone, state] of insuranceState) {
    if (state.stage !== 'WAITING_QUOTE') continue;

    const submitted = new Date(state.data.submittedAt || 0);
    const elapsed = Date.now() - submitted.getTime();
    const minutes = elapsed / (60 * 1000);

    // 30 min — first nudge to group
    if (minutes > 30 && (state.data.followUpCount || 0) === 0) {
      await _config.waSendText(insuranceGroup,
        `*Reminder:* Insurance quote pending for ${state.data.customerName} (${state.data.regNumber || state.data.carDetails}).\n` +
        `Coverage: ${state.data.coverage}\n` +
        `_Submitted ${Math.round(minutes)} minutes ago._`
      );
      state.data.followUpCount = 1;
      insuranceState.set(phone, state);
    }

    // 2 hours — alert admin
    if (minutes > 120 && (state.data.followUpCount || 0) === 1) {
      if (_config.ADMIN_WA && _config.ADMIN_WA !== insuranceGroup) {
        await _config.waSendText(_config.ADMIN_WA,
          `*URGENT:* Insurance quote delayed 2+ hours\n` +
          `Customer: ${state.data.customerName} (${phone})\n` +
          `Coverage: ${state.data.coverage}\n` +
          `Car: ${state.data.regNumber || state.data.carDetails}`
        );
      }
      state.data.followUpCount = 2;
      insuranceState.set(phone, state);
    }
  }
}

// ==================== RECEIVE QUOTE (admin replies) ====================

async function receiveQuote(customerPhone, quoteText) {
  const state = insuranceState.get(customerPhone);
  if (!state || state.stage !== 'WAITING_QUOTE') return false;

  // Forward quote to customer
  let msg = `*Your Insurance Quote is Ready!*\n\n`;
  msg += `Coverage: *${state.data.coverage}*\n`;
  if (state.data.regNumber) msg += `Car: *${state.data.regNumber}*\n`;
  msg += `\n${quoteText}\n\n`;

  const buttons = [
    { type: 'reply', reply: { id: 'INS_ACCEPT', title: 'Accept' } },
    { type: 'reply', reply: { id: 'INS_COMPARE', title: 'Compare More' } },
    { type: 'reply', reply: { id: 'INS_DECLINE', title: 'Not Now' } }
  ];

  await _config.waSendText(customerPhone, msg);
  await _config.waSendRaw({
    messaging_product: 'whatsapp', to: customerPhone, type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Would you like to proceed?' },
      action: { buttons }
    }
  });

  state.stage = 'QUOTE_SENT';
  _config.setLastService(customerPhone, 'INS_QUOTE');
  insuranceState.set(customerPhone, state);
  return true;
}

// Handle customer's response to quote
async function handleQuoteResponse(from, id) {
  const state = insuranceState.get(from);
  if (!state || state.stage !== 'QUOTE_SENT') return false;

  if (id === 'INS_ACCEPT' || /accept|yes|proceed|book/i.test(id)) {
    // Forward email + phone to insurance group for link generation
    const insuranceGroup = (process.env.INSURANCE_GROUP_WA || _config.ADMIN_WA || '').trim();
    if (insuranceGroup) {
      await _config.waSendText(insuranceGroup,
        `*ACCEPTED — Generate Policy Link*\n\n` +
        `Customer: *${state.data.customerName}*\n` +
        `Email: *${state.data.email}*\n` +
        `Phone: *${state.data.phone}*\n` +
        `Coverage: *${state.data.coverage}*\n` +
        `Car: *${state.data.regNumber || state.data.carDetails}*\n\n` +
        `_Please generate payment link and share._`
      );
    }

    await _config.waSendText(from,
      '*Great choice!*\n\n' +
      'Your policy payment link will be sent to your email shortly.\n\n' +
      `Email: ${state.data.email}\nPhone: ${state.data.phone}`
    );

    state.stage = 'LINK_PENDING';
    insuranceState.set(from, state);
    return true;
  }

  if (id === 'INS_COMPARE') {
    await _config.waSendText(from,
      'We\'ll get you more options. Please wait while we check with other insurers.'
    );
    state.stage = 'WAITING_QUOTE';
    state.data.followUpCount = 0;
    state.data.submittedAt = new Date().toISOString();
    insuranceState.set(from, state);
    return true;
  }

  if (id === 'INS_DECLINE' || /no|not now|cancel|later/i.test(id)) {
    await _config.waSendText(from,
      'No problem! We\'ll keep your details on file. You can come back anytime.\n\n' +
      'We\'ll also remind you when your policy is due for renewal.'
    );
    insuranceState.delete(from);
    _config.setLastService(from, '');
    return true;
  }

  return false;
}

// ==================== INSURANCE DONE ====================

async function markComplete(customerPhone) {
  const state = insuranceState.get(customerPhone);

  await _config.waSendText(customerPhone,
    `*Thank you for choosing MR. CAR for your insurance!*\n\n` +
    `Your policy details will be emailed shortly.\n\n` +
    `*Our Future Services:*\n` +
    `• Systematic *insurance renewal reminders* — we'll remind you before expiry\n` +
    `• *Claim assistance* — 24/7 helpline numbers & guided process\n` +
    `• *Policy comparison* at every renewal for best rates\n` +
    `• *Loan options* — Vanilla, Bullet, Step-Up/Step-Down\n` +
    `• *RC transfer* assistance\n` +
    `• *Road Side Assistance (RSA)* — 1 year\n\n` +
    `Need anything? Type *hi* anytime.\n\n` +
    `_MR. CAR — Your Trusted Car Partner_`
  );

  insuranceState.delete(customerPhone);
  _config.setLastService(customerPhone, '');
}

// ==================== DETECT INSURANCE INTENT ====================

function isInsuranceIntent(text) {
  return /\b(insurance|insure|policy|renewal|renew|bima|beema|third party|comprehensive|0 dep|zero dep|tp|od)\b/i.test(text || '');
}

function hasActiveState(from) {
  const state = insuranceState.get(from);
  return state && !['', undefined].includes(state.stage);
}

module.exports = {
  init,
  startInsurance,
  handleMessage,
  receiveQuote,
  handleQuoteResponse,
  markComplete,
  isInsuranceIntent,
  hasActiveState,
  COVERAGE_EXPLAIN
};
