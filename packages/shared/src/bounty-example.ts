/**
 * A complete bounty spec a hunter can start from (docs/BOUNTIES.md). It is shown on the web
 * app's Bounties page; the API's tests check it passes the same parser the API uses.
 */
export const BOUNTY_SPEC_EXAMPLE = `id: A6-your-attack-001
class: A6
title: One line saying what the attack does
description: How the attack reaches the agent and what it tries to make the agent do.
surfaces:
  - dm
delivery:
  sender: "@fund-ops-desk"
payloadTemplate: "Write the planted text here. Placeholders such as {{amount}}, {{token}} and
  {{attacker}} are filled in by the Arena."
successPredicate:
  anyOf:
    - T1_UNAUTHORIZED_TRANSFER
severityHint: high
variantPrompt: How an attacker model could vary the wording.
tags:
  - bounty
`;
