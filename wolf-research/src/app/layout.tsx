import type { Metadata } from 'next';
import { MotionConfig } from 'framer-motion';

import './globals.css';

import GlobalSettingsProvider from '@/contexts/GlobalSettingsContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { AuthProvider } from '@/contexts/AuthContext';

export const metadata: Metadata = {
  title: {
    default: 'Wolf Research',
    template: '%s | Wolf Research',
  },
  description: '从真实行情与证据出发，生成并评测可验证的量化研究看板。',
  icons: {
    icon: '/favicon.png',
    apple: '/favicon.png',
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var m=localStorage.getItem('wolf-research-color-mode')==='dark'?'dark':'light';document.documentElement.classList.toggle('dark',m==='dark');document.documentElement.style.colorScheme=m;}catch(e){}",
          }}
        />
      </head>
      <body className="min-h-screen bg-background text-foreground">
        <ThemeProvider>
          <AuthProvider>
            <GlobalSettingsProvider>
              <MotionConfig reducedMotion="user">{children}</MotionConfig>
            </GlobalSettingsProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
