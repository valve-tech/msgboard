import { Welcome } from '../components/Welcome'
import { FullScreen } from '../components/FullScreen'
import { SalesPitch } from '../components/SalesPitch'
import { ProtocolComparison } from '../components/ProtocolComparison'
import { Interactive } from '../components/Interactive'
import { NextSteps } from '../components/NextSteps'
import { Footer } from '../components/Footer'
import { Docs } from '../components/Docs'
import { UseCases } from '../components/UseCases'
import { JoinNetwork } from '../components/JoinNetwork'
import { GamesCallout } from '../components/GamesCallout'
import { Ecosystem } from '../components/Ecosystem'
import { SideToc } from '../components/SideToc'

const sections = [
  { id: 'overview', label: 'Overview' },
  { id: 'try-it', label: 'Try it' },
  { id: 'use-cases', label: 'Use cases' },
  { id: 'games', label: 'Games' },
  { id: 'ecosystem', label: 'Ecosystem' },
  { id: 'api', label: 'API' },
  { id: 'network', label: 'Network' },
  { id: 'compare', label: 'Compare' },
  { id: 'next-steps', label: 'Next steps' },
]

/** Ported from `pages/Home.svelte` — the landing layout. */
export function Home() {
  return (
    <>
      <SideToc sections={sections} />

      <section id="top">
        <Welcome />
      </section>
      <section id="overview" className="scroll-mt-16">
        <SalesPitch />
      </section>
      <section id="try-it" className="scroll-mt-16">
        <FullScreen
          id="interactive-container"
          className="flex bg-gray-50 dark:bg-gray-900 w-full flex-row items-center justify-center shadow">
          <Interactive />
        </FullScreen>
      </section>
      <section id="use-cases" className="scroll-mt-16">
        <UseCases />
      </section>
      <section id="games" className="scroll-mt-16">
        <GamesCallout />
      </section>
      <section id="ecosystem" className="scroll-mt-16">
        <Ecosystem />
      </section>
      <section id="api" className="scroll-mt-16">
        <Docs />
      </section>
      <section id="network" className="scroll-mt-16">
        <JoinNetwork />
      </section>
      <section id="compare" className="scroll-mt-16">
        <ProtocolComparison />
      </section>
      <section id="next-steps" className="scroll-mt-16">
        <NextSteps />
      </section>
      <Footer />
    </>
  )
}
