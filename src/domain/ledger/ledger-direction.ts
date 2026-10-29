export const LedgerDirection = { Debit: 'DEBIT', Credit: 'CREDIT' } as const;
export type LedgerDirection = (typeof LedgerDirection)[keyof typeof LedgerDirection];
