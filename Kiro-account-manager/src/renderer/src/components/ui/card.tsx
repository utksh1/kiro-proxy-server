import * as React from 'react'
import { cn } from '@/lib/utils'

export type CardVariant = 'glass' | 'glass-strong' | 'glass-subtle' | 'solid' | 'elevated'

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * card variations
   * - glass        : Default glassy state (translucent + blur）
   * - glass-strong : More opaque glass (ideal for content that requires greater readability)
   * - glass-subtle : Light glass (suitable for secondary containers, toolbars)
   * - solid        : opaque solid color Card(Backwards compatible with old code)
   * - elevated     : solid color Card + stronger shadow
   */
  variant?: CardVariant
  /** Whether to enable hover Float animation */
  interactive?: boolean
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant = 'glass', interactive = false, ...props }, ref) => {
    const variantClass: Record<CardVariant, string> = {
      'glass': 'glass-card text-card-foreground',
      'glass-strong': 'glass-card-strong text-card-foreground',
      'glass-subtle': 'glass-card-subtle text-card-foreground',
      'solid': 'bg-card text-card-foreground border shadow',
      'elevated': 'bg-card text-card-foreground border shadow-lg'
    }
    return (
      <div
        ref={ref}
        className={cn(
          'rounded-2xl', // 24px rounded corners
          variantClass[variant],
          interactive && 'hover-lift cursor-pointer',
          className
        )}
        {...props}
      />
    )
  }
)
Card.displayName = 'Card'

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col space-y-1.5 p-6', className)} {...props} />
  )
)
CardHeader.displayName = 'CardHeader'

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('font-semibold leading-none tracking-tight', className)} {...props} />
  )
)
CardTitle.displayName = 'CardTitle'

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
  )
)
CardDescription.displayName = 'CardDescription'

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('p-6 pt-0', className)} {...props} />
)
CardContent.displayName = 'CardContent'

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center p-6 pt-0', className)} {...props} />
  )
)
CardFooter.displayName = 'CardFooter'

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
