import { WHATSAPP_CONSENT } from '@vat-assist/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import WhatsAppConsent from '../app/whatsapp-consent';
import { mockApi, mockRouter, reset, route } from './harness';

beforeEach(reset);

it('shows the consent wording and records the opt-in with its version', async () => {
  route({ '/whatsapp-consent': () => ({ optIn: true }) });
  render(<WhatsAppConsent />);
  expect(screen.getByText(WHATSAPP_CONSENT.text.en)).toBeTruthy();
  fireEvent.press(screen.getByText('wa.agree'));
  await waitFor(() => expect(mockApi).toHaveBeenCalledWith('/orgs/org-1/whatsapp-consent', { body: { optIn: true, consentVersion: WHATSAPP_CONSENT.version } }));
  expect(mockRouter.back).toHaveBeenCalled();
});

it('leaving without agreeing records nothing', () => {
  render(<WhatsAppConsent />);
  fireEvent.press(screen.getByText('common.continue'));
  expect(mockRouter.back).toHaveBeenCalled();
  expect(mockApi).not.toHaveBeenCalled();
});
