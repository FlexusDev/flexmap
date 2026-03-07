import { expect } from 'chai';

describe('FlexMap App Launch', () => {
  it('should display the main window', async () => {
    const title = await browser.getTitle();
    expect(title).to.include('FlexMap');
  });

  it('should render the editor canvas', async () => {
    const canvas = await browser.$('canvas');
    expect(await canvas.isExisting()).to.be.true;
  });

  it('should render the toolbar', async () => {
    const toolbar = await browser.$('[data-testid="toolbar"]');
    expect(await toolbar.isExisting()).to.be.true;
  });

  it('should render the layer panel', async () => {
    const panel = await browser.$('[data-testid="layer-panel"]');
    expect(await panel.isExisting()).to.be.true;
  });
});
