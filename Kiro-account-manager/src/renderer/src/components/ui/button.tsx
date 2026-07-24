import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // Default main CTA:Solid color + hover float + main color glow
        default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90 hover:-translate-y-px hover:shadow-[var(--glass-shadow-glow)]',
        // Dangerous operation: red + hover red glow
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 hover:-translate-y-px hover:shadow-[0_0_0_1px_rgba(239,68,68,0.25),0_8px_24px_rgba(239,68,68,0.25)]',
        // Glass outline: No padding by default,hover Show light color + float
        outline: 'border border-[var(--glass-border-strong)] bg-[var(--glass-bg-subtle)] backdrop-blur-md shadow-sm hover:bg-[var(--glass-bg)] hover:text-foreground hover:-translate-y-px',
        // secondary: Glassy feeling
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 hover:-translate-y-px',
        // ghost:transparent,hover Show light background
        ghost: 'hover:bg-white/40 dark:hover:bg-white/5 hover:text-foreground',
        // link: Underline
        link: 'text-primary underline-offset-4 hover:underline',
        // gradient:host CTA Emphasis style, theme gradient + continuous breathing glow
        gradient: 'gradient-bg-primary shadow-md hover:-translate-y-px breathe-glow text-white border-0'
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-lg px-3 text-xs',
        lg: 'h-11 rounded-xl px-6 text-base',
        cta: 'h-12 rounded-2xl px-8 text-base font-semibold', // main Call-to-Action button
        icon: 'h-9 w-9 rounded-lg'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
