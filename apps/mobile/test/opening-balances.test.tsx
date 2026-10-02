import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import OpeningBalances from '../app/opening-balances';
import { bodyOf, mockRouter, reset, route, state } from './harness';

beforeEach(reset);
const notYet = { recorded: false, startDate: '2026-07-01', accounts: [], openItems: [] };
const addRow = (i: number) => fireEvent.press(screen.getAllByText('onb.addRow')[i]!);

it('onboarding: saves cash, bank, stock, who owes what and VAT credit, then moves on', async () => {
  state.params = { first: '1' };
  route({ '/opening-balances': (init) => (init?.body ? { entryNo: 1, openItems: 2 } : notYet) });
  render(<OpeningBalances />);
  await screen.findByText(/onb.openingHint/);
  if (!screen.queryByLabelText('onb.bankName')) addRow(0);
  if (!screen.queryByLabelText('inv.customer')) addRow(1);
  if (!screen.queryByLabelText('pay.who')) addRow(2);
  fireEvent.changeText(screen.getByLabelText('onb.cash'), '15000');
  fireEvent.changeText(screen.getByLabelText('onb.bankName'), 'MCB current account');
  fireEvent.changeText(screen.getAllByLabelText('Rs')[0]!, '250000');
  fireEvent.changeText(screen.getByLabelText('onb.stock'), '180000');
  fireEvent.changeText(screen.getByLabelText('inv.customer'), 'Hotel Demo Ltd');
  fireEvent.changeText(screen.getAllByLabelText('Rs')[1]!, '1200');
  fireEvent.changeText(screen.getByLabelText('pay.who'), 'Grossiste Demo Ltd');
  fireEvent.changeText(screen.getAllByLabelText('Rs')[2]!, '3450');
  fireEvent.changeText(screen.getByLabelText('onb.vatCredit'), '250');
  fireEvent.press(screen.getByText('common.save'));

  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/home'));
  expect(bodyOf('/opening-balances')).toMatchObject({
    cashInHandCents: 1_500_000,
    bankBalances: [{ name: 'MCB current account', amountCents: 25_000_000 }],
    stockCents: 18_000_000,
    customersOwe: [expect.objectContaining({ name: 'Hotel Demo Ltd', amountCents: 120_000 })],
    suppliersOwed: [expect.objectContaining({ name: 'Grossiste Demo Ltd', amountCents: 345_000 })],
    vatCreditCarriedForwardCents: 25_000,
  });
});

it('shows what was recorded instead of the form once opening balances exist', async () => {
  route({ '/opening-balances': () => ({ ...notYet, recorded: true, accounts: [{ name: 'Bank', net_cents: 25_000_000 }], openItems: [{ id: 'o1', name: 'Hotel Demo Ltd', gross_cents: 120_000 }] }) });
  render(<OpeningBalances />);
  expect(await screen.findByText('onb.saved')).toBeTruthy();
  expect(screen.queryByLabelText('onb.cash')).toBeNull();
});
