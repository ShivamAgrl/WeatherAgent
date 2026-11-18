import { render, screen } from '@testing-library/react';
import App from './App';

test('renders the weather agent chat', () => {
  render(<App />);
  expect(screen.getByText(/weather agent/i)).toBeInTheDocument();
});
