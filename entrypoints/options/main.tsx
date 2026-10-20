import { render } from 'preact';
import { OptionsApp } from '../../ui/options/OptionsApp';
import '../../ui/options/options.css';

const root = document.getElementById('app');
if (root) render(<OptionsApp />, root);
