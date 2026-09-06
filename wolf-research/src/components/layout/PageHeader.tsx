import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: string;
  badge?: ReactNode;
  subtitle?: string;
  children?: ReactNode;
  backHref?: string | false;
  compactOnMobile?: boolean;
  showAccount?: boolean;
  className?: string;
}

function PageHeader({
  title,
  badge,
  subtitle,
  children,
  backHref = '/',
  compactOnMobile = false,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn('platform-header', className)}>
      <div
        className={cn(
          'flex min-h-[4.5rem] w-full items-stretch justify-between gap-3 px-4 py-3 lg:flex-row lg:items-center lg:px-6',
          compactOnMobile ? 'flex-row items-center' : 'flex-col',
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {backHref !== false ? (
            <Button variant="ghost" size="icon" asChild className="shrink-0">
              <Link href={backHref} aria-label="返回研究工作台">
                <ArrowLeft className="h-5 w-5" />
              </Link>
            </Button>
          ) : null}
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            <span aria-hidden="true">W</span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-xl font-bold tracking-normal text-foreground">{title}</h1>
              {badge ? <span className="shrink-0">{badge}</span> : null}
            </div>
            {subtitle ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          {children}
          <Button variant="ghost" size="sm" asChild>
            <Link href="/eval-platform">评测中心</Link>
          </Button>
          <ThemeToggle compact />
        </div>
      </div>
    </header>
  );
}

export { PageHeader };
export type { PageHeaderProps };
