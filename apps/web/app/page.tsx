import { redirect } from 'next/navigation';
import { accessToken } from '@/lib/session';

export default async function Home() {
  redirect((await accessToken()) ? '/reviewer' : '/login');
}
