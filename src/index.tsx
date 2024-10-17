import { Command, Context, h, SessionError, Schema as z } from 'koishi'
import {} from 'koishi-plugin-puppeteer'

export const name = 'w-tree'

export const inject = {
    optional: [ 'component:html' ]
}

export interface Config {
    indent: number
    maxDepth: number
    maxSubcommandCount: number
    toImage: boolean
    style: 'indent' | 'ascii' | 'asciiex'
    customCss: Record<string, string>
}

export const Config: z<Config> = z.object({
    indent: z.natural().min(2).default(4).description('The default indention length.'),
    maxDepth: z.natural().default(10).description('The default maximum depth of command trees.'),
    maxSubcommandCount: z.natural().default(5).description('The default maximum count of displayed subscommands'),
    toImage: z.boolean().default(true).description('Whether to render command trees to images.'),
    style: z.union([ 'indent', 'ascii', 'asciiex' ]).default('ascii').description('The default style to use.'),
    customCss: z.dict(z.string()).default({
        'padding': '1em',
        'line-height': '1',
        'font-feature-settings': `'liga' on`
    }).description(`Custom CSS rules.`)
})

export function apply(ctx: Context, config: Config) {
    const STYLES: Record<Config['style'], () => {
        white: string, bar: string, item: string, lastItem: string
    }> = {
        indent: () => ({
            white: ' '.repeat(config.indent),
            bar: ' '.repeat(config.indent),
            item: '',
            lastItem: ''
        }),
        ascii: () => ({
            white: ' '.repeat(config.indent),
            bar: '|' + ' '.repeat(config.indent - 1),
            item: '+- ',
            lastItem: '`- ' 
        }),
        asciiex: () => ({
            white: ' '.repeat(config.indent),
            bar: '|' + ' '.repeat(config.indent - 1),
            item: '├── ',
            lastItem: '└── '
        })
    }

    ctx.command('tree [command:string]', 'Display the command tree.')
        .option('maxDepth', '-L <max-depth:natural> maximum depth of the command tree.')
        .option('maxSub', '-m <max-sub:natural> maximun count of displayed subcommands.')
        .option('fullpath', '-p Display full paths of subcommands.')
        .option('image', '-i Render to image.')
        .option('image', '-I Not render to image.', { value: false })
        .option('filter', '-f <filter:string> Search for commands.')
        .option('style', `-s <style> Style to use. Available styles: ${Object.keys(STYLES).join(' | ')}` as const, {
            type: new RegExp(`^${Object.keys(STYLES).join('|')}$`),
        })
        .action(({
            session,
            options: {
                maxDepth = config.maxDepth,
                maxSub = config.maxSubcommandCount,
                style: styleName = config.style,
                fullpath,
                image = config.toImage,
                filter
            }
        }, path) => {
            const style = STYLES[styleName]()

            const renderCommandTree = (tree: CommandTree, indention: string, depth: number): string => {
                const { display, desc, matched, subs, subsTooLong } = tree
                const headerText = (
                    (matched && ! image ? `(*) ${display}` : display) +
                    (desc ? `: ${desc}` : '')
                )
                const subsText = subs
                    .map<
                        | { type: 'command', command: CommandTree }
                        | { type: 'ellipsis' }
                    >(sub => ({ type: 'command', command: sub }))
                    .concat(subsTooLong ? [ { type: 'ellipsis' } ] : [])
                    .map((item, index, { length }) => {
                        const isLast = index === length - 1
                        return indention
                            + (isLast ? style.lastItem : style.item)
                            + (
                                item.type === 'command' ?
                                    renderCommandTree(item.command, indention + (isLast ? style.white : style.bar), depth + 1) :
                                item.type === 'ellipsis' ?
                                    '...' :
                                ''
                            )
                    })
                    .join(<br />)
                return (
                    (matched && image
                        ? <strong style='color: red;'>{ headerText }</strong>
                        : headerText
                    ) +
                    (depth < maxDepth && subs.length
                        ? <br /> + subsText
                        : ''
                    )
                )
            }

            type CommandTree = {
                display: string
                desc: string
                subs: CommandTree[]
                matched: boolean
                subsMatched: boolean
                subsTooLong: boolean
            }

            const removeHoisted = (commands: Command[]) => {
                const hoisted = new Set<string>
                commands.forEach(command => {
                    const prefix = command.name + '.'
                    commands.forEach(({ name }) => {
                        if (name.startsWith(prefix)) hoisted.add(name)
                    })
                })
                return commands.filter(({ name }) => ! hoisted.has(name))
            }

            const getCommandSubs = (commands: Command[]): CommandTree[] => {
                const subs = removeHoisted(commands)
                    .map(getCommandTree)
                    .filter(sub => ! filter || sub.subsMatched)
                    .sort((_, sub) => + sub.subsMatched)
                return subs
            }

            const getCommandTree = (command: Command): CommandTree => {
                const { name, children } = command
                const desc = h.unescape(session.text([ `commands.${name}.description`, '' ]))
                const display = h.unescape(fullpath ? name : name.split('.').at(- 1))
                const matched = display.includes(filter)
                const subs = getCommandSubs(children)
                const subsMatched = matched || subs.some(sub => sub.subsMatched)

                return {
                    display,
                    desc,
                    subs: subs.slice(0, maxSub),
                    matched,
                    subsMatched,
                    subsTooLong: subs.length > maxSub
                }
            }

            const getCommandRoot = (): CommandTree => {
                if (path) {
                    const { command } = ctx.$commander._resolve(path)
                    if (! command) throw new SessionError('command-not-found', [ command ])
                    return getCommandTree(command)
                }
                else {
                    const subs = getCommandSubs(ctx.$commander._commandList)
                    return {
                        display: '',
                        desc: null,
                        matched: false,
                        subs,
                        subsMatched: subs.some(sub => sub.subsMatched),
                        subsTooLong: false
                    }
                }
            }

            const output = renderCommandTree(getCommandRoot(), '', 0)

            const css = Object
                .entries(config.customCss)
                .map(([ key, value ]) => `${key}: ${value};`)
                .join(' ')

            return image
                ? <html><pre style={css}>{ h.parse(output) }</pre></html>
                : output
        })
}
