import dotenv from 'dotenv';
dotenv.config({ override: true });

import { sendToTim, sendButtonsToTim } from '../src/services/whatsapp.js';

async function main() {
  const plan = `📋 *Content Plan — Vibe-Coding Projects Page*

Creating a new page on your Tim Cox site to showcase your coding projects.

*1. Create Page* — New page in main navigation
   Title: "Vibe-Coding Projects", slug: /vibe-coding-projects

*2. Page Header*
   📌 Heading: "VIBE-CODING PROJECTS"
   📝 "Here's where ideas meet execution. Check out the digital magic I've been cooking up in the code kitchen."

*3. Spacer* — Visual separation

*4. Project Template* — Two-column layout (image + text)
   📌 "Project Title Goes Here"
   📝 Description placeholder
   🔘 Button: "VIEW PROJECT"

*5. Instructions Section*
   📌 "READY TO ADD MORE?"
   📝 Guide on how to duplicate for new projects

⏱ Estimated: ~8 min`;

  await sendToTim(plan);
  await sendButtonsToTim('Approve this plan?', [
    { id: 'plan_approve', title: 'Looks good!' },
    { id: 'plan_reject', title: 'Skip this' },
  ]);
  console.log('Plan sent!');
}

main().catch(console.error);
