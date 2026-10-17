import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import stylelint from 'stylelint'
import { expect, test } from 'vitest'

const config = JSON.parse(readFileSync(resolve(process.cwd(), '.stylelintrc.json'), 'utf8'))

test('rejects box-shadow and text-shadow', async () => {
  const res = await stylelint.lint({ code: '.a{box-shadow:0 0 1px red}.b{text-shadow:none}', config })
  const warnings = res.results[0].warnings.filter((w) => w.rule === 'property-disallowed-list')
  expect(warnings).toHaveLength(2)
})

test('accepts the theme files', async () => {
  const res = await stylelint.lint({ files: 'src/**/*.css', config })
  expect(res.errored).toBe(false)
})
