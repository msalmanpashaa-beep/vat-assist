import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import NewInvoice from '../app/invoice-new';
import { bodyOf, mockApi, reset, route } from './harness';

beforeEach(reset);

it('captures a credit invoice: customer, line, VAT code, due date; confirms with the reference', async () => {
  route({ '/contacts': () => [], '/sales-invoices': () => ({ reference: 'INV-00003', grossCents: 460_000, dueDate: '2026-11-15' }) });
  render(<NewInvoice />);
  fireEvent.changeText(screen.getByLabelText('inv.customer'), 'Hotel Demo Ltd');
  fireEvent.changeText(screen.getByLabelText('inv.phone'), '+23057123456');
  fireEvent(screen.getByLabelText('inv.consent'), 'valueChange', true);
  fireEvent.changeText(screen.getByLabelText('inv.due'), '2026-11-15');
  fireEvent.changeText(screen.getByLabelText('inv.line'), 'Catering supplies');
  fireEvent.changeText(screen.getByLabelText('inv.amount'), '4000');
  fireEvent.press(screen.getByText('common.save'));

  expect(await screen.findByText(/inv.saved/)).toBeTruthy();
  const body = bodyOf('/sales-invoices');
  expect(body.customerName).toBe('Hotel Demo Ltd');
  expect(body.settlement).toEqual({ mode: 'credit', dueDate: '2026-11-15' });
  expect(body.lines[0]).toMatchObject({ description: 'Catering supplies', netCents: 400_000, vatCode: 'SR' });
});

it('does not send an invoice with no customer or amount', async () => {
  route({ '/contacts': () => [] });
  render(<NewInvoice />);
  fireEvent.press(screen.getByText('common.save'));
  await waitFor(() => expect(mockApi.mock.calls.some((c) => String(c[0]).includes('/sales-invoices'))).toBe(false));
  expect(screen.queryByText(/inv.saved/)).toBeNull();
});
