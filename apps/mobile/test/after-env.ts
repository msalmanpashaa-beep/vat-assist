import { configure } from '@testing-library/react-native';

// The first suite pays for a cold Babel transform; give async queries room so results do not depend on machine speed.
configure({ asyncUtilTimeout: 5000 });
