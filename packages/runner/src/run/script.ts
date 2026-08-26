/**
 * Turns a scenario's declared script into a ScriptedAgent.
 *
 * The default system under test. A scenario that declares no script gets an
 * agent that does nothing, which is a legitimate run - it records that the
 * agent attempted no money actions - rather than an error.
 */

import type { ScriptedStep } from '@adversary/agents';
import { ScriptedAgent } from '@adversary/agents';
import type { PaymentAgent } from '@adversary/core';

import type { Scenario } from '../scenario/schema.js';

export function scriptFor(scenario: Scenario): PaymentAgent {
  return new ScriptedAgent({
    name: 'scripted',
    // The schema and the agent's step union are the same shape by
    // construction; the Zod schema in scenario/schema.ts is what validates it.
    script: scenario.script as readonly ScriptedStep[],
    finalMessage: `Script for ${scenario.id} complete.`,
  });
}
