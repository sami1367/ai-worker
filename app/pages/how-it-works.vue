<script setup lang="ts">
import { forgePracticeKeys, labelLifecycleSections, providerDocKeys } from '../utils/how-it-works-doc'

const { t } = useI18n()

const implementSteps = [
  'howItWorks.workflows.implement.step1',
  'howItWorks.workflows.implement.step2',
  'howItWorks.workflows.implement.step3',
  'howItWorks.workflows.implement.step4',
  'howItWorks.workflows.implement.step5',
] as const

const qaSteps = [
  'howItWorks.workflows.qa.step1',
  'howItWorks.workflows.qa.step2',
  'howItWorks.workflows.qa.step3',
  'howItWorks.workflows.qa.step4',
] as const

const reviewSteps = [
  'howItWorks.workflows.review.step1',
  'howItWorks.workflows.review.step2',
  'howItWorks.workflows.review.step3',
  'howItWorks.workflows.review.step4',
] as const

const repoOptionKeys = [
  'howItWorks.repoOptions.targetBranch',
  'howItWorks.repoOptions.freshCheckout',
  'howItWorks.repoOptions.forcePush',
  'howItWorks.repoOptions.codegraph',
] as const

const tipKeys = [
  'howItWorks.tips.item1',
  'howItWorks.tips.item2',
  'howItWorks.tips.item3',
  'howItWorks.tips.item4',
  'howItWorks.tips.item5',
] as const

const setupKeys = [
  'howItWorks.panel.setup.item1',
  'howItWorks.panel.setup.item2',
  'howItWorks.panel.setup.item3',
  'howItWorks.panel.setup.item4',
] as const

const pageKeys = [
  'howItWorks.panel.pages.dashboard',
  'howItWorks.panel.pages.connections',
  'howItWorks.panel.pages.repositories',
  'howItWorks.panel.pages.tasks',
  'howItWorks.panel.pages.providers',
  'howItWorks.panel.pages.prompts',
  'howItWorks.panel.pages.settings',
  'howItWorks.panel.pages.system',
  'howItWorks.panel.pages.audit',
] as const

const youAddLabels = [
  { name: 'ai', descKey: 'howItWorks.labels.ai' as const },
  { name: 'no-change', descKey: 'howItWorks.labels.noChange' as const },
  { name: 'ai-review', descKey: 'howItWorks.labels.aiReview' as const },
]

const workerLabels = [
  { name: 'ai-working', descKey: 'howItWorks.labels.aiWorking' as const },
  { name: 'ai-pr', descKey: 'howItWorks.labels.aiPr' as const },
  { name: 'ai-answered', descKey: 'howItWorks.labels.aiAnswered' as const },
  { name: 'ai-failed', descKey: 'howItWorks.labels.aiFailed' as const },
  { name: 'ai-reviewing', descKey: 'howItWorks.labels.aiReviewing' as const },
  { name: 'ai-reviewed', descKey: 'howItWorks.labels.aiReviewed' as const },
  { name: 'ai-review-failed', descKey: 'howItWorks.labels.aiReviewFailed' as const },
]
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-8 aw-fade-in">
    <div>
      <h1 class="font-display text-3xl tracking-tight">
        {{ t('howItWorks.title') }}
      </h1>
      <p class="mt-1 text-sm opacity-70">
        {{ t('howItWorks.subtitle') }}
      </p>
    </div>

    <section class="aw-panel space-y-3 rounded-xl p-5" aria-labelledby="how-intro">
      <h2 id="how-intro" class="font-display text-xl">
        {{ t('howItWorks.intro.heading') }}
      </h2>
      <p class="text-sm leading-relaxed opacity-90">
        {{ t('howItWorks.intro.p1') }}
      </p>
      <p class="text-sm leading-relaxed opacity-90">
        {{ t('howItWorks.intro.p2') }}
      </p>
    </section>

    <section class="aw-panel space-y-4 rounded-xl p-5" aria-labelledby="how-providers">
      <h2 id="how-providers" class="font-display text-xl">
        {{ t('howItWorks.providers.heading') }}
      </h2>
      <p class="text-sm leading-relaxed opacity-90">
        {{ t('howItWorks.providers.intro') }}
      </p>
      <ul class="list-disc space-y-2 ps-5 text-sm leading-relaxed opacity-90">
        <li v-for="key in providerDocKeys" :key="key">
          {{ t(key) }}
        </li>
      </ul>
    </section>

    <section class="aw-panel space-y-4 rounded-xl p-5" aria-labelledby="how-forge">
      <h2 id="how-forge" class="font-display text-xl">
        {{ t('howItWorks.forge.heading') }}
      </h2>
      <p class="text-sm leading-relaxed opacity-90">
        {{ t('howItWorks.forge.intro') }}
      </p>

      <div class="space-y-2 border-t border-[var(--aw-line)] pt-4">
        <h3 class="text-sm font-medium">
          {{ t('howItWorks.forge.practice.heading') }}
        </h3>
        <ul class="list-disc space-y-2 ps-5 text-sm leading-relaxed opacity-90">
          <li v-for="key in forgePracticeKeys" :key="key">
            {{ t(key) }}
          </li>
        </ul>
      </div>

      <div class="space-y-2 border-t border-[var(--aw-line)] pt-4">
        <h3 class="text-sm font-medium">
          {{ t('howItWorks.forge.tokens.heading') }}
        </h3>
        <ul class="list-disc space-y-2 ps-5 text-sm leading-relaxed opacity-90">
          <li>{{ t('howItWorks.forge.tokens.github') }}</li>
          <li>{{ t('howItWorks.forge.tokens.gitlab') }}</li>
          <li>{{ t('howItWorks.forge.tokens.git') }}</li>
        </ul>
      </div>
    </section>

    <section class="aw-panel space-y-5 rounded-xl p-5" aria-labelledby="how-workflows">
      <h2 id="how-workflows" class="font-display text-xl">
        {{ t('howItWorks.workflows.heading') }}
      </h2>

      <div class="space-y-2">
        <h3 class="text-sm font-medium">
          {{ t('howItWorks.workflows.implement.heading') }}
        </h3>
        <ol class="list-decimal space-y-2 ps-5 text-sm leading-relaxed opacity-90">
          <li v-for="key in implementSteps" :key="key">
            {{ t(key) }}
          </li>
        </ol>
      </div>

      <div class="space-y-2 border-t border-[var(--aw-line)] pt-4">
        <h3 class="text-sm font-medium">
          {{ t('howItWorks.workflows.qa.heading') }}
        </h3>
        <ol class="list-decimal space-y-2 ps-5 text-sm leading-relaxed opacity-90">
          <li v-for="key in qaSteps" :key="key">
            {{ t(key) }}
          </li>
        </ol>
      </div>

      <div class="space-y-2 border-t border-[var(--aw-line)] pt-4">
        <h3 class="text-sm font-medium">
          {{ t('howItWorks.workflows.review.heading') }}
        </h3>
        <ol class="list-decimal space-y-2 ps-5 text-sm leading-relaxed opacity-90">
          <li v-for="key in reviewSteps" :key="key">
            {{ t(key) }}
          </li>
        </ol>
      </div>
    </section>

    <section class="aw-panel space-y-4 rounded-xl p-5" aria-labelledby="how-lifecycle">
      <h2 id="how-lifecycle" class="font-display text-xl">
        {{ t('howItWorks.lifecycle.heading') }}
      </h2>
      <p class="text-sm leading-relaxed opacity-90">
        {{ t('howItWorks.lifecycle.intro') }}
      </p>
      <div
        v-for="section in labelLifecycleSections"
        :key="section.heading"
        class="space-y-2 border-t border-[var(--aw-line)] pt-4"
      >
        <h3 class="text-sm font-medium">
          {{ t(section.heading) }}
        </h3>
        <p class="text-sm leading-relaxed opacity-90">
          {{ t(section.body) }}
        </p>
      </div>
    </section>

    <section class="aw-panel space-y-3 rounded-xl p-5" aria-labelledby="how-repo-options">
      <h2 id="how-repo-options" class="font-display text-xl">
        {{ t('howItWorks.repoOptions.heading') }}
      </h2>
      <p class="text-sm leading-relaxed opacity-90">
        {{ t('howItWorks.repoOptions.intro') }}
      </p>
      <ul class="list-disc space-y-2 ps-5 text-sm leading-relaxed opacity-90">
        <li v-for="key in repoOptionKeys" :key="key">
          {{ t(key) }}
        </li>
      </ul>
    </section>

    <section class="aw-panel space-y-4 rounded-xl p-5" aria-labelledby="how-labels">
      <h2 id="how-labels" class="font-display text-xl">
        {{ t('howItWorks.labels.heading') }}
      </h2>
      <p class="text-sm leading-relaxed opacity-90">
        {{ t('howItWorks.labels.intro') }}
      </p>

      <div class="space-y-2">
        <p class="text-xs font-medium uppercase tracking-wide opacity-60">
          {{ t('howItWorks.labels.youAdd') }}
        </p>
        <ul class="space-y-2 text-sm">
          <li
            v-for="label in youAddLabels"
            :key="label.name"
            class="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3"
          >
            <code class="shrink-0 rounded bg-black/5 px-1.5 py-0.5 font-mono text-xs dark:bg-white/10 sm:w-36">
              {{ label.name }}
            </code>
            <span class="opacity-90">{{ t(label.descKey) }}</span>
          </li>
        </ul>
      </div>

      <div class="space-y-2 border-t border-[var(--aw-line)] pt-4">
        <p class="text-xs font-medium uppercase tracking-wide opacity-60">
          {{ t('howItWorks.labels.workerAdds') }}
        </p>
        <ul class="space-y-2 text-sm">
          <li
            v-for="label in workerLabels"
            :key="label.name"
            class="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3"
          >
            <code class="shrink-0 rounded bg-black/5 px-1.5 py-0.5 font-mono text-xs dark:bg-white/10 sm:w-36">
              {{ label.name }}
            </code>
            <span class="opacity-90">{{ t(label.descKey) }}</span>
          </li>
        </ul>
      </div>
    </section>

    <section class="aw-panel space-y-3 rounded-xl p-5" aria-labelledby="how-tips">
      <h2 id="how-tips" class="font-display text-xl">
        {{ t('howItWorks.tips.heading') }}
      </h2>
      <ul class="list-disc space-y-2 ps-5 text-sm leading-relaxed opacity-90">
        <li v-for="key in tipKeys" :key="key">
          {{ t(key) }}
        </li>
      </ul>
    </section>

    <section class="aw-panel space-y-4 rounded-xl p-5" aria-labelledby="how-panel">
      <h2 id="how-panel" class="font-display text-xl">
        {{ t('howItWorks.panel.heading') }}
      </h2>
      <p class="text-sm leading-relaxed opacity-90">
        {{ t('howItWorks.panel.intro') }}
      </p>

      <div class="space-y-2 border-t border-[var(--aw-line)] pt-4">
        <h3 class="text-sm font-medium">
          {{ t('howItWorks.panel.setup.heading') }}
        </h3>
        <ol class="list-decimal space-y-2 ps-5 text-sm leading-relaxed opacity-90">
          <li v-for="key in setupKeys" :key="key">
            {{ t(key) }}
          </li>
        </ol>
      </div>

      <div class="space-y-2 border-t border-[var(--aw-line)] pt-4">
        <h3 class="text-sm font-medium">
          {{ t('howItWorks.panel.pages.heading') }}
        </h3>
        <ul class="list-disc space-y-2 ps-5 text-sm leading-relaxed opacity-90">
          <li v-for="key in pageKeys" :key="key">
            {{ t(key) }}
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>
