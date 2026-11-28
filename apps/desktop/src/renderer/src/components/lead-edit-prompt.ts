import { leadAccessInstructions, type LeadAccess } from '@kai/contracts';
import { leadCoachPrompt } from './guided-build-engine';
import { LEAD_RECOVERY_RULES } from './lead-recovery';

export function leadDevelopmentPrompt(message: string, style: Parameters<typeof leadCoachPrompt>[1], detail: Parameters<typeof leadCoachPrompt>[2], questions: Parameters<typeof leadCoachPrompt>[3], access: LeadAccess = 'read-only'): string {
  const prompt = leadCoachPrompt(message, style, detail, questions);
  return (access === 'read-only' ? prompt : prompt.replace('Lead is always read-only: never create, edit, delete or run a command that changes files.', 'Your model tools remain read-only. You may propose a small edit for KAI to preview and apply through the separate approval workflow.')) + '\n\n' + leadAccessInstructions(access) + '\n\n' + LEAD_RECOVERY_RULES;
}
export function stripLeadEdit(text: string): string {
  return text.replace(/^LEAD EDIT:\s*\n[\s\S]*?^END LEAD EDIT\s*$/gm, '').trim();
}
export function hasLeadEdit(text: string): boolean { return /^LEAD EDIT:/m.test(text); }
