import { load } from 'cheerio';
import { htmlToJson } from '../../collaboration/collaboration.util';
import { transformConfluencePanels } from './confluence-panel.utils';

describe('transformConfluencePanels', () => {
  it('preserves a Confluence panel as an Akasha panel node', () => {
    const html = transformConfluencePanels(`
      <div class="panel" style="border-style: dashed; border-color: red; border-width: 2px; background-color: #eeeeee">
        <div class="panelHeader" style="background-color: #dddddd; color: blue"><b>测试</b></div>
        <div class="panelContent"><p>dsadsa</p><p>dsadas</p></div>
      </div>
    `);
    const $ = load(html, null, false);
    const $panel = $('div[data-type="panel"]');

    expect($panel.attr('data-panel-title')).toBe('测试');
    expect($panel.attr('data-panel-border-style')).toBe('dashed');
    expect($panel.attr('data-panel-border-color')).toBe('red');
    expect($panel.attr('data-panel-border-width')).toBe('2');
    expect($panel.attr('data-panel-bg-color')).toBe('#eeeeee');
    expect($panel.attr('data-panel-title-bg-color')).toBe('#dddddd');
    expect($panel.attr('data-panel-title-color')).toBe('blue');
    expect(
      $panel
        .children('p')
        .map((_, el) => $(el).text())
        .get(),
    ).toEqual(['dsadsa', 'dsadas']);
    expect($panel.find('.panelHeader, .panelContent')).toHaveLength(0);

    const document = htmlToJson(html);
    expect(document.content).toEqual([
      expect.objectContaining({
        type: 'panel',
        attrs: expect.objectContaining({
          title: '测试',
          borderStyle: 'dashed',
          borderColor: 'red',
          borderWidth: 2,
          bgColor: '#eeeeee',
          titleBgColor: '#dddddd',
          titleColor: 'blue',
        }),
        content: [
          expect.objectContaining({ type: 'paragraph' }),
          expect.objectContaining({ type: 'paragraph' }),
        ],
      }),
    ]);
  });

  it('does not convert Confluence code panels', () => {
    const html = transformConfluencePanels(`
      <div class="code panel">
        <div class="panelContent"><pre class="syntaxhighlighter-pre">code</pre></div>
      </div>
    `);

    expect(html).toContain('class="code panel"');
    expect(html).not.toContain('data-type="panel"');
  });
});
