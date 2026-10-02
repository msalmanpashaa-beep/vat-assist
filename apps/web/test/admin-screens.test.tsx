import './helpers';
import { resolveFeatures } from '@vat-assist/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientAssignments, type ClientRow } from '@/components/admin/ClientAssignments';
import { FeatureFlagsTable } from '@/components/admin/FeatureFlagsTable';
import { StaffAdmin, type StaffRow } from '@/components/admin/StaffAdmin';
import { calls, mockApi } from './helpers';

afterEach(cleanup);
const reviewer: StaffRow = { user_id: 'u1', email: 'reviewer@nexgen.test', full_name: 'Demo Reviewer', roles: ['reviewer'], totp_enabled: true, disabled: false, invite_pending: false, recovery_codes_left: 0, client_count: 3 };
const senior: StaffRow = { ...reviewer, user_id: 'u2', email: 'senior@nexgen.test', full_name: 'Demo Senior', roles: ['senior_reviewer'] };
const client: ClientRow = { org_id: 'o1', org_name: 'Boutik Demo', legal_name: 'Boutik Demo Ltd', vat_number: '99999902', staff: [{ userId: 'u1', name: 'Demo Reviewer', email: 'reviewer@nexgen.test', role: 'reviewer' }], features: resolveFeatures(null) };

describe('Staff screen', () => {
  it('checks the invite before sending, then shows the one-time link', async () => {
    mockApi(() => ({ userId: 'u9', inviteUrl: 'http://localhost:3000/invite/abc123' }));
    render(<StaffAdmin staff={[reviewer]} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Invite staff' }));
    expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(/valid email/);
    expect(calls).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new.reviewer@nexgen.test' } });
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'New Reviewer' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'senior_reviewer' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Invite staff' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/invite\/abc123/);
    expect(calls[0]).toMatchObject({ url: '/api/proxy/admin/staff', method: 'POST', body: { email: 'new.reviewer@nexgen.test', fullName: 'New Reviewer', role: 'senior_reviewer' } });
  });

  it('resets 2FA after confirmation and shows a one-time recovery code', async () => {
    mockApi((url) => (url.endsWith('/recovery-code') ? { code: 'ABCDE-FGHJK' } : { totpEnabled: false }));
    window.confirm = vi.fn(() => true);
    render(<StaffAdmin staff={[reviewer]} />);
    fireEvent.click(screen.getByText('Reset 2FA'));
    await waitFor(() => expect(calls[0]).toMatchObject({ url: '/api/proxy/admin/staff/u1/reset-2fa', method: 'POST' }));
    fireEvent.click(screen.getByText('Recovery code'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/ABCDE-FGHJK/));
  });
});

describe('Clients and reviewers screen', () => {
  it('reassigns selected clients in bulk, replacing the previous reviewer', async () => {
    mockApi(() => ({ reassigned: 1 }));
    render(<ClientAssignments clients={[client]} staff={[reviewer, senior]} />);
    fireEvent.click(screen.getByLabelText('Select Boutik Demo'));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'u2' } });
    fireEvent.change(screen.getByLabelText('As'), { target: { value: 'senior_reviewer' } });
    fireEvent.change(screen.getByLabelText('Replacing (optional)'), { target: { value: 'u1' } });
    fireEvent.click(screen.getByText('Reassign selected'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ url: '/api/proxy/admin/assignments/bulk', body: { orgIds: ['o1'], toUserId: 'u2', role: 'senior_reviewer', fromUserId: 'u1' } });
  });

  it('unassigns one reviewer from one client', async () => {
    mockApi(() => ({ removed: 1 }));
    render(<ClientAssignments clients={[client]} staff={[reviewer, senior]} />);
    fireEvent.click(screen.getByLabelText('Remove Demo Reviewer from Boutik Demo'));
    await waitFor(() => expect(calls[0]).toMatchObject({ url: '/api/proxy/admin/orgs/o1/staff/u1', method: 'DELETE' }));
  });
});

describe('Feature flags screen', () => {
  it('switches one screen off for one business', async () => {
    mockApi(() => resolveFeatures({ credit_invoices: false }));
    render(<FeatureFlagsTable clients={[client]} />);
    const box = screen.getByLabelText('Invoices on credit for Boutik Demo') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(calls[0]).toMatchObject({ url: '/api/proxy/admin/orgs/o1/features', method: 'PUT', body: { features: { credit_invoices: false } } }));
    await waitFor(() => expect((screen.getByLabelText('Invoices on credit for Boutik Demo') as HTMLInputElement).checked).toBe(false));
  });
});
