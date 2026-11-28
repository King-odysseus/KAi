/** Recognises current and older saved price pauses without treating them as chat failures. */
export function isLeadPricePause(note: string | undefined): boolean {
  return Boolean(note && /paid usage could not be measured/i.test(note));
}
export function leadPricePause(source: string): string {
  return `Automatic review/continuation paused: paid usage could not be measured for ${source}. Token counts do not provide a dollar price for an unknown model or gateway alias. Choose “Review once with Lead” for one explicit review, or select a local reviewer. Normal Lead chat is still available. Automatic paid work stays paused while cycle spending is unknown.`;
}
