import { WHATSAPP_CONSENT } from '@vat-assist/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import SettingsScreen from '../app/settings';
import { mockApi, mockRouter, reset, route, state } from './harness';

beforeEach(reset);
const off = { debtorRemindersEnabled: false, whatsappOptIn: false, scheduledInvoiceReminders: 0 };

it('switching invoice reminders on saves the setting and reports what was scheduled', async () => {
  route({ '/settings': (init) => (init?.method === 'PATCH' ? { ...off, debtorRemindersEnabled: true, scheduledInvoiceReminders: 2, scheduled: 2, cancelled: 0 } : off) });
  render(<SettingsScreen />);
  fireEvent(await screen.findByLabelText('set.invoiceReminders'), 'valueChange', true);
  await waitFor(() => expect(mockApi).toHaveBeenCalledWith('/orgs/org-1/settings', { method: 'PATCH', body: { debtorRemindersEnabled: true } }));
  expect(await screen.findByText(/set.scheduled/)).toBeTruthy();
});

it('switching reminders off cancels them through the same setting', async () => {
  route({ '/settings': (init) => (init?.method === 'PATCH' ? { ...off, scheduled: 0, cancelled: 2 } : { ...off, debtorRemindersEnabled: true }) });
  render(<SettingsScreen />);
  fireEvent(await screen.findByLabelText('set.invoiceReminders'), 'valueChange', false);
  await waitFor(() => expect(mockApi).toHaveBeenCalledWith('/orgs/org-1/settings', { method: 'PATCH', body: { debtorRemindersEnabled: false } }));
});

it('WhatsApp on goes to the consent screen first; off is recorded straight away', async () => {
  route({ '/settings': () => ({ ...off, whatsappOptIn: true }), '/whatsapp-consent': () => ({ optIn: false }) });
  render(<SettingsScreen />);
  fireEvent(await screen.findByLabelText('set.whatsapp'), 'valueChange', false);
  await waitFor(() => expect(mockApi).toHaveBeenCalledWith('/orgs/org-1/whatsapp-consent', { body: { optIn: false, consentVersion: WHATSAPP_CONSENT.version } }));
  fireEvent(screen.getByLabelText('set.whatsapp'), 'valueChange', true);
  expect(mockRouter.push).toHaveBeenCalledWith('/whatsapp-consent');
});

it('hides both switches when Nex-Gen has turned the features off for this business', async () => {
  state.features = { ...state.features, invoice_reminders: false, whatsapp_opt_in: false };
  route({ '/settings': () => off });
  render(<SettingsScreen />);
  await waitFor(() => expect(mockApi).toHaveBeenCalled());
  expect(screen.queryByLabelText('set.invoiceReminders')).toBeNull();
  expect(screen.queryByLabelText('set.whatsapp')).toBeNull();
});
