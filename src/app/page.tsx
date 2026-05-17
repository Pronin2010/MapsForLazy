'use client';

import dynamic from 'next/dynamic';

// Dynamic import to avoid SSR issues with Leaflet
const OrienteeringMap = dynamic(() => import('@/components/orienteering-map'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-screen flex flex-col items-center justify-center bg-background gap-4">
      <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent" />
      <p className="text-muted-foreground text-sm">Загрузка карты...</p>
    </div>
  ),
});

export default function Home() {
  return <OrienteeringMap />;
}
