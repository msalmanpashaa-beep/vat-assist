import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import RecordPayment from '../app/record-payment';
import { bodyOf, mockApi, reset, route, state } from './harness';

beforeEach(reset);
const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
const item = (transactionId: string, reference: string, issueDate: string, outstandingCents: number) => ({
  transactionId, contactId: 'c1', contactName: 'X', reference, issueDate, dueDate: null, outstandingCents, days: 10, bucket: '0-30',
});
const report = (name: string, items: ReturnType<typeof item>[]) => ({
  asOf: '2026-10-01', basis: 'invoice_date', total: 0, buckets,
  contacts: [{ contactId: 'c1', contactName: name, total: 0, buckets, items }],
});

it('customer payment by Juice, applied oldest first across two invoices (one partly)', async () => {
  state.params = { side: 'receive' };
  route({
    '/ageing': () => report('Hotel Demo Ltd', [item('t-old', 'OPENING', '2026-05-10', 120_000), item('t-new', 'INV-00001', '2026-09-15', 460_000)]),
    '/payments': () => ({ transactionId: 'r1' }),
  });
  render(<RecordPayment />);
  await screen.findByText(/INV-00001/);
  fireEvent.changeText(screen.getAllByLabelText('pay.amount')[0]!, '2000');
  fireEvent.press(screen.getByText(/juice/i));
  fireEvent.press(screen.getByText('Oldest first'));
  fireEvent.press(screen.getByText('common.save'));

  expect(await screen.findByText('pay.saved')).toBeTruthy();
  expect(mockApi).toHaveBeenCalledWith(expect.stringContaining('side=receivable'));
  expect(bodyOf('/payments')).toMatchObject({
    kind: 'receipt', contactId: 'c1', method: 'juice', amountCents: 200_000,
    allocations: [{ invoiceId: 't-old', amountCents: 120_000 }, { invoiceId: 't-new', amountCents: 80_000 }],
  });
});

it('supplier payment by bank clears the bill in full', async () => {
  state.params = { side: 'pay' };
  route({
    '/ageing': () => report('Grossiste Demo Ltd', [item('b1', 'INV-0457', '2026-08-03', 460_000)]),
    '/payments': () => ({ transactionId: 'p1' }),
  });
  render(<RecordPayment />);
  await screen.findByText(/INV-0457/);
  fireEvent.changeText(screen.getAllByLabelText('pay.amount')[0]!, '4600');
  fireEvent.press(screen.getByText(/bank/i));
  fireEvent.press(screen.getByText('Oldest first'));
  fireEvent.press(screen.getByText('common.save'));

  await waitFor(() => expect(bodyOf('/payments')).toMatchObject({
    kind: 'payment', method: 'bank', amountCents: 460_000, allocations: [{ invoiceId: 'b1', amountCents: 460_000 }],
  }));
  expect(mockApi).toHaveBeenCalledWith(expect.stringContaining('side=payable'));
});
