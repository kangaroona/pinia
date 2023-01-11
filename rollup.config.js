// @ts-check
import path from 'path'
import ts from 'rollup-plugin-typescript2'
import replace from '@rollup/plugin-replace'
import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import pascalcase from 'pascalcase'
import terser from '@rollup/plugin-terser'

if (!process.env.TARGET) {
  throw new Error('TARGET package must be specified via --environment flag.')
}

const packagesDir = path.resolve(__dirname, 'packages')
const packageDir = path.resolve(packagesDir, process.env.TARGET)

const pkg = require(path.resolve(packageDir, `package.json`))
const name = pkg.name

function getAuthors(pkg) {
  const { contributors, author } = pkg

  const authors = new Set()
  if (contributors && contributors)
    contributors.forEach((contributor) => {
      authors.add(contributor.name)
    })
  if (author) authors.add(author.name)

  return Array.from(authors).join(', ')
}

const banner = `/*!
  * ${pkg.name} v${pkg.version}
  * (c) ${new Date().getFullYear()} ${getAuthors(pkg)}
  * @license MIT
  */`

// ensure TS checks only once for each build
let hasTSChecked = false

const outputConfigs = {
  // each file name has the format: `dist/${name}.${format}.js`
  // format being a key of this object
  mjs: {
    file: pkg.module,
    format: `es`,
  },
  cjs: {
    file: pkg.module.replace('mjs', 'cjs'),
    format: `cjs`,
  },
  global: {
    file: pkg.unpkg,
    format: `iife`,
  },
  browser: {
    file: 'dist/pinia.esm-browser.js',
    format: `es`,
  },
}

const packageBuilds = Object.keys(outputConfigs)
const packageConfigs = packageBuilds.map((format) =>
  createConfig(format, outputConfigs[format])
)
console.log('🚀 ~ file: rollup.config.js:67 ~ packageConfigs', packageConfigs)

// only add the production ready if we are bundling the options
packageBuilds.forEach((buildName) => {
  if (buildName === 'cjs') {
    packageConfigs.push(createProductionConfig(buildName))
  } else if (buildName === 'global') {
    packageConfigs.push(createMinifiedConfig(buildName))
  }
})

export default packageConfigs

function createConfig(buildName, output, plugins = []) {
  if (!output) {
    console.log(require('chalk').yellow(`invalid format: "${buildName}"`))
    process.exit(1)
  }

  output.sourcemap = !!process.env.SOURCE_MAP
  output.banner = banner
  output.externalLiveBindings = false
  output.globals = {
    'vue-demi': 'VueDemi',
    vue: 'Vue',
    '@vue/composition-api': 'vueCompositionApi',
  }

  const isProductionBuild = /\.prod\.[cm]?js$/.test(output.file)
  const isGlobalBuild = buildName === 'global'
  const isRawESMBuild = buildName === 'browser'
  const isNodeBuild = buildName === 'cjs'
  const isBundlerESMBuild = buildName === 'browser' || buildName === 'mjs'

  if (isGlobalBuild) output.name = pascalcase(pkg.name)

  const shouldEmitDeclarations = !hasTSChecked

  const tsPlugin = ts({
    check: !hasTSChecked,
    tsconfig: path.resolve(__dirname, './tsconfig.json'),
    cacheRoot: path.resolve(__dirname, './node_modules/.rts2_cache'),
    tsconfigOverride: {
      compilerOptions: {
        sourceMap: output.sourcemap,
        declaration: shouldEmitDeclarations,
        declarationMap: shouldEmitDeclarations,
      },
      exclude: ['packages/*/__tests__', 'packages/*/test-dts'],
    },
  })
  // we only need to check TS and generate declarations once for each build.
  // it also seems to run into weird issues when checking multiple times
  // during a single build.
  hasTSChecked = true

  const external = ['vue-demi', 'vue', '@vue/composition-api']
  if (
    !isGlobalBuild &&
    // pinia.prod.cjs should not require `@vue/devtools-api` (like Vue)
    !(isProductionBuild && isNodeBuild)
  ) {
    external.push('@vue/devtools-api')
  }

  const nodePlugins = [resolve(), commonjs()]

  return {
    input: `src/index.ts`,
    // Global and Browser ESM builds inlines everything so that they can be
    // used alone.
    external,
    plugins: [
      tsPlugin,
      createReplacePlugin(
        isProductionBuild,
        isBundlerESMBuild,
        // isBrowserBuild?
        isRawESMBuild,
        isGlobalBuild,
        isNodeBuild
      ),
      ...nodePlugins,
      ...plugins,
    ],
    output,
    // onwarn: (msg, warn) => {
    //   if (!/Circular/.test(msg)) {
    //     warn(msg)
    //   }
    // },
  }
}

function createReplacePlugin(
  isProduction,
  isBundlerESMBuild,
  isRawESMBuild,
  isGlobalBuild,
  isNodeBuild
) {
  const replacements = {
    __COMMIT__: `"${process.env.COMMIT}"`,
    __VERSION__: `"${pkg.version}"`,
    __DEV__:
      (isBundlerESMBuild && !isRawESMBuild) || (isNodeBuild && !isProduction)
        ? // preserve to be handled by bundlers
          `(process.env.NODE_ENV !== 'production')`
        : // hard coded dev/prod builds
          JSON.stringify(!isProduction),
    // this is only used during tests
    __TEST__:
      (isBundlerESMBuild && !isRawESMBuild) || isNodeBuild
        ? `(process.env.NODE_ENV === 'test')`
        : 'false',
    __FEATURE_PROD_DEVTOOLS__: isBundlerESMBuild
      ? `(typeof __VUE_PROD_DEVTOOLS__ !== 'undefined' && __VUE_PROD_DEVTOOLS__)`
      : 'false',
    // If the build is expected to run directly in the browser (global / esm builds)
    __BROWSER__: JSON.stringify(isRawESMBuild),
    // is targeting bundlers?
    __BUNDLER__: JSON.stringify(isBundlerESMBuild),
    __GLOBAL__: JSON.stringify(isGlobalBuild),
    // is targeting Node (SSR)?
    __NODE_JS__: JSON.stringify(isNodeBuild),
  }
  // allow inline overrides like
  //__RUNTIME_COMPILE__=true yarn build
  Object.keys(replacements).forEach((key) => {
    if (key in process.env) {
      replacements[key] = process.env[key]
    }
  })

  return replace({
    preventAssignment: true,
    values: replacements,
  })
}

function createProductionConfig(format) {
  const extension = format === 'cjs' ? 'cjs' : 'js'
  const descriptor = format === 'cjs' ? '' : `.${format}`
  return createConfig(format, {
    file: `dist/${name}${descriptor}.prod.${extension}`,
    format: outputConfigs[format].format,
  })
}

function createMinifiedConfig(format) {
  return createConfig(
    format,
    {
      file: `dist/${name}.${format === 'global' ? 'iife' : format}.prod.js`,
      format: outputConfigs[format].format,
    },
    [
      terser({
        module: /^esm/.test(format),
        compress: {
          ecma: 2015,
          pure_getters: true,
        },
      }),
    ]
  )
}
