/** What a message to the Lead is: a question, a change of direction, or more to build. */
export type CrewRoute = 'ask' | 'steer' | 'work';

export const ROUTE_LABEL: Record<CrewRoute, string> = {
  ask: 'a question',
  steer: 'a change of direction',
  work: 'more work',
};

const QUESTION_START = /^(what|what's|whats|why|how|when|where|who|which|is|are|was|were|am|does|did|has|have|will|would|should|could|can|explain|show|tell|list|summari[sz]e|describe|compare)\b/i;
const REQUEST_VERB = /^(start|begin|build|implement|add|create|fix|change|update|continue|go|run|install|remove|delete|refactor|finish|make|write|set up|setup|deploy|test|use|switch|replace|rename|move|proceed|carry on|keep|skip|ignore|don't|do not|never|always|only|also|now|stop)\b/i;

/**
 * Works out what a message to the Lead means, so the person does not have to choose. A question is answered and changes
 * nothing; anything else is a request, which steers a crew that is working and plans more onto one that has finished.
 * A polite wrapper ("can you start Phase 1?", "please add X") does not make a request a question.
 */
export function routeMessage(text: string, finished: boolean): CrewRoute {
  const flat = text.trim().replace(/\s+/g, ' ');
  if (!flat) return 'ask';
  const bare = flat
    .replace(/^(?:hey|hi|ok|okay|so|and|then)[, ]+/i, '')
    .replace(/^(?:can|could|would|will|shall) (?:you|we) (?:please )?/i, '')
    .replace(/^please[, ]*/i, '')
    .replace(/^(?:i want you to|i would like you to|i'd like you to|let's|lets) /i, '');
  const request: CrewRoute = finished ? 'work' : 'steer';
  if (bare !== flat && REQUEST_VERB.test(bare)) return request;
  if (flat.endsWith('?') || QUESTION_START.test(flat)) return 'ask';
  return request;
}
