import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { type PilotScore, PilotScorecard } from '@/components/admin/PilotScorecard';

afterEach(cleanup);
const s: PilotScore = {
  shops: { value: 10, target: 10, pass: true },
  activationRate: { value: 0.9, activated: 9, target: 0.8, pass: true },
  reviewerMinutes: { averagePerShop: 24, maxPerShop: 41, shopsAtOrOverTarget: 3, target: 20, pass: false },
  onTimeFilingRate: { value: 1, onTime: 10, due: 10, target: 0.95, pass: true },
  churnRate: { value: 0.1, churned: 1, target: 0.1, pass: true },
  referrals: { value: 2, target: 3, pass: false },
};

describe('Pilot scorecard', () => {
  it('shows each metric against its target and marks what is behind', () => {
    render(<PilotScorecard s={s} />);
    const tile = (name: string) => within(screen.getByRole('group', { name }));
    expect(tile('Activation').getByText('90%')).toBeTruthy();
    expect(tile('Activation').getByText(/On track/)).toBeTruthy();
    expect(tile('Reviewer minutes per shop').getByText('24')).toBeTruthy();
    expect(tile('Reviewer minutes per shop').getByText(/Behind · target < 20 per quarter/)).toBeTruthy();
    expect(tile('On-time filing').getByText('10 of 10 returns due')).toBeTruthy();
    expect(tile('Referrals').getByText(/Behind/)).toBeTruthy();
  });
});
