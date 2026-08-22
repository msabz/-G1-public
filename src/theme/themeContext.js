import React, { createContext, useContext, useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { lightColors, darkColors } from './colors';
import { getThemeMode, persistThemeMode } from '../services/Persistence';

const ThemeContext = createContext({
  theme: darkColors,
  mode: 'dark',
  isDark: true,
  setThemeMode: () => {},
});

export const ThemeProvider = ({ children }) => {
  const systemColorScheme = useColorScheme();
  const [mode, setMode] = useState('system');

  useEffect(() => {
    let active = true;
    getThemeMode().then(savedMode => {
      if (active) setMode(savedMode);
    });
    return () => { active = false; };
  }, []);

  const setThemeMode = nextMode => {
    if (!['system', 'light', 'dark'].includes(nextMode)) return;
    setMode(nextMode);
    persistThemeMode(nextMode);
  };

  const isDark = mode === 'system' ? systemColorScheme === 'dark' : mode === 'dark';
  const theme = isDark ? darkColors : lightColors;

  return (
    <ThemeContext.Provider
      value={{
        theme,
        mode,
        isDark,
        setThemeMode,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
};

export const useAppTheme = () => useContext(ThemeContext);
