// auth-guard.js - ABE GTM Platform Authentication Module
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
const WORKER_API_BASE = 'YOUR_CLOUDFLARE_WORKER_URL';

class AuthGuard {
    constructor() {
        this.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        this.currentUser = null;
        this.currentOrg = null;
    }

    // Initialize and check current session
    async initialize() {
        const { data: { session } } = await this.supabase.auth.getSession();
        
        if (session) {
            this.currentUser = session.user;
            await this.loadUserProfile();
            return true;
        }
        
        return false;
    }

    // Load user profile and organization
    async loadUserProfile() {
        const { data: profile, error } = await this.supabase
            .from('user_profiles')
            .select('*, organizations(id, name, plan_tier)')
            .eq('id', this.currentUser.id)
            .single();

        if (error) {
            console.error('Failed to load user profile:', error);
            return null;
        }

        this.currentUser.profile = profile;
        
        // Load organization membership
        if (profile.organization_id) {
            const { data: org } = await this.supabase
                .from('organizations')
                .select('*')
                .eq('id', profile.organization_id)
                .single();
            
            this.currentOrg = org;
        }

        return profile;
    }

    // Email/Password Signup
    async signup(email, password, termsAccepted, marketingConsent) {
        try {
            // Step 1: Get device fingerprint for trial tracking
            const deviceId = this.getDeviceFingerprint();
            
            // Step 2: Check trial eligibility via Cloudflare Worker
            const trialCheck = await this.checkTrialEligibility(email, deviceId);
            
            if (!trialCheck.eligible) {
                throw new Error('Free trial already used on this device. Please select a paid plan.');
            }

            // Step 3: Sign up with Supabase Auth
            const { data, error } = await this.supabase.auth.signUp({
                email,
                password,
                options: {
                    data: {
                        terms_accepted: termsAccepted,
                        marketing_consent: marketingConsent
                    }
                }
            });

            if (error) throw error;

            // Step 4: Create user profile and organization
            await this.createUserProfile(data.user, {
                termsAccepted,
                marketingConsent,
                deviceId
            });

            // Step 5: Show onboarding modal
            this.showOnboardingModal();

            return data;
        } catch (error) {
            console.error('Signup error:', error);
            throw error;
        }
    }

    // Email/Password Login
    async login(email, password) {
        try {
            const { data, error } = await this.supabase.auth.signInWithPassword({
                email,
                password
            });

            if (error) throw error;

            this.currentUser = data.user;
            await this.loadUserProfile();

            // Check if onboarding is complete
            if (!this.currentUser.profile?.onboarding_completed) {
                this.showOnboardingModal();
            } else {
                window.location.href = '/dashboard.html';
            }

            return data;
        } catch (error) {
            console.error('Login error:', error);
            throw error;
        }
    }

    // Google OAuth
    async signInWithGoogle() {
        try {
            // Use explicit redirect URL to avoid localhost issues
            const redirectUrl = window.location.hostname === 'localhost' 
                ? 'http://localhost:3000/auth-callback.html'
                : `${window.location.origin}/auth-callback.html`;

            console.log('🔐 Initiating Google OAuth with redirect:', redirectUrl);

            const { data, error } = await this.supabase.auth.signInWithOAuth({
                provider: 'google',
                options: {
                    redirectTo: redirectUrl,
                    queryParams: {
                        access_type: 'offline',
                        prompt: 'consent'
                    }
                }
            });

            if (error) throw error;

            // OAuth will redirect - this code won't run
            console.log('✅ Redirecting to Google for authentication...');

            return data;
        } catch (error) {
            console.error('❌ Google sign-in error:', error);
            throw error;
        }
    }

    // Magic Link
    async sendMagicLink(email) {
        try {
            const { data, error } = await this.supabase.auth.signInWithOtp({
                email,
                options: {
                    emailRedirectTo: `${window.location.origin}/auth/callback`
                }
            });

            if (error) throw error;

            return data;
        } catch (error) {
            console.error('Magic link error:', error);
            throw error;
        }
    }

    // Phone/SMS OTP (Placeholder for Supabase Phone Auth)
    async sendPhoneOTP(phone) {
        try {
            const { data, error } = await this.supabase.auth.signInWithOtp({
                phone,
                options: {
                    channel: 'sms'
                }
            });

            if (error) throw error;

            return data;
        } catch (error) {
            console.error('Phone OTP error:', error);
            throw error;
        }
    }

    async verifyPhoneOTP(phone, token) {
        try {
            const { data, error } = await this.supabase.auth.verifyOtp({
                phone,
                token,
                type: 'sms'
            });

            if (error) throw error;

            return data;
        } catch (error) {
            console.error('OTP verification error:', error);
            throw error;
        }
    }

    // Create user profile with organization
    async createUserProfile(user, options = {}) {
        const { termsAccepted, marketingConsent, deviceId } = options;

        try {
            // Create default organization for new user
            const { data: org, error: orgError } = await this.supabase
                .from('organizations')
                .insert({
                    name: `${user.email}'s Organization`,
                    plan_tier: 'free_trial',
                    owner_id: user.id
                })
                .select()
                .single();

            if (orgError) throw orgError;

            // Create user profile
            const { data: profile, error: profileError } = await this.supabase
                .from('user_profiles')
                .insert({
                    id: user.id,
                    email: user.email,
                    organization_id: org.id,
                    plan: 'free_trial',
                    tc_accepted: termsAccepted,
                    marketing_consent: marketingConsent,
                    device_id: deviceId,
                    onboarding_completed: false,
                    created_at: new Date().toISOString()
                })
                .select()
                .single();

            if (profileError) throw profileError;

            // Create organization membership
            await this.supabase
                .from('organization_members')
                .insert({
                    organization_id: org.id,
                    user_id: user.id,
                    role: 'owner'
                });

            // Log signup event to Worker
            await this.logSignupEvent(user.id, deviceId);

            return profile;
        } catch (error) {
            console.error('Create user profile error:', error);
            throw error;
        }
    }

    // Complete onboarding
    async completeOnboarding(onboardingData) {
        try {
            const { data, error } = await this.supabase
                .from('user_profiles')
                .update({
                    full_name: onboardingData.fullName,
                    company_name: onboardingData.companyName,
                    job_title: onboardingData.jobTitle,
                    department: onboardingData.department,
                    company_size: onboardingData.companySize,
                    geography: onboardingData.geography,
                    onboarding_completed: true,
                    updated_at: new Date().toISOString()
                })
                .eq('id', this.currentUser.id)
                .select()
                .single();

            if (error) throw error;

            // Also update organization name with company name
            if (this.currentOrg) {
                await this.supabase
                    .from('organizations')
                    .update({ name: onboardingData.companyName })
                    .eq('id', this.currentOrg.id);
            }

            return data;
        } catch (error) {
            console.error('Onboarding error:', error);
            throw error;
        }
    }

    // Check trial eligibility via Cloudflare Worker
    async checkTrialEligibility(email, deviceId) {
        try {
            // Check if user is admin (bypass all restrictions)
            const adminEmails = ['amitbhawik@gmail.com', 'amitbhawik@hotmail.com'];
            if (adminEmails.includes(email.toLowerCase())) {
                return { eligible: true, isAdmin: true };
            }

            // Check with worker
            const response = await fetch(`${WORKER_API_BASE}/api/check-trial`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, deviceId })
            });

            if (!response.ok) {
                // Fail open - if worker is down, allow signup
                console.warn('Trial check service unavailable, allowing signup');
                return { eligible: true, failOpen: true };
            }

            const data = await response.json();
            return data;
        } catch (error) {
            console.error('Trial eligibility check failed:', error);
            // Fail open - allow signup if check fails
            return { eligible: true, failOpen: true };
        }
    }

    // Log signup event
    async logSignupEvent(userId, deviceId) {
        try {
            await fetch(`${WORKER_API_BASE}/api/log-signup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId,
                    deviceId,
                    timestamp: new Date().toISOString()
                })
            });
        } catch (error) {
            console.error('Failed to log signup event:', error);
            // Non-critical, don't throw
        }
    }

    // Generate device fingerprint
    getDeviceFingerprint() {
        // Simple fingerprint based on browser characteristics
        const fingerprint = {
            userAgent: navigator.userAgent,
            language: navigator.language,
            platform: navigator.platform,
            screenResolution: `${screen.width}x${screen.height}`,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            colorDepth: screen.colorDepth
        };

        // Create hash
        const str = JSON.stringify(fingerprint);
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }

        return `fp_${Math.abs(hash).toString(36)}`;
    }

    // Show onboarding modal
    showOnboardingModal() {
        const modal = document.getElementById('onboarding-modal');
        if (modal) {
            modal.classList.add('active');
        }
    }

    // Logout
    async logout() {
        const { error } = await this.supabase.auth.signOut();
        if (error) {
            console.error('Logout error:', error);
            throw error;
        }
        window.location.href = '/login.html';
    }

    // Check if user is authenticated
    async requireAuth() {
        const isAuthenticated = await this.initialize();
        
        if (!isAuthenticated) {
            window.location.href = '/login.html';
            return false;
        }

        return true;
    }

    // Check if user is admin
    isAdmin() {
        const adminEmails = ['amitbhawik@gmail.com', 'amitbhawik@hotmail.com'];
        return this.currentUser?.profile?.is_admin === true || 
               adminEmails.includes(this.currentUser?.email?.toLowerCase());
    }

    // Get current organization context
    getOrgContext() {
        return {
            organizationId: this.currentOrg?.id,
            planTier: this.currentOrg?.plan_tier,
            userId: this.currentUser?.id,
            isAdmin: this.isAdmin()
        };
    }

    // Handle OAuth callback
    async handleOAuthCallback() {
        const { data, error } = await this.supabase.auth.getSession();
        
        if (error) {
            console.error('OAuth callback error:', error);
            window.location.href = '/login.html';
            return;
        }

        if (data.session) {
            this.currentUser = data.session.user;
            
            // Check if profile exists
            const { data: profile } = await this.supabase
                .from('user_profiles')
                .select('*')
                .eq('id', this.currentUser.id)
                .single();

            if (!profile) {
                // New OAuth user - create profile
                await this.createUserProfile(this.currentUser, {
                    termsAccepted: true, // Implied by OAuth
                    marketingConsent: false,
                    deviceId: this.getDeviceFingerprint()
                });
                this.showOnboardingModal();
            } else if (!profile.onboarding_completed) {
                this.showOnboardingModal();
            } else {
                window.location.href = '/dashboard.html';
            }
        }
    }
}

// Initialize auth guard
const authGuard = new AuthGuard();

// Make available globally
window.authGuard = authGuard;

// Auto-initialize on page load
const currentPath = window.location.pathname;

if (currentPath.includes('/auth-callback.html') || currentPath === '/auth/callback') {
    // OAuth callback is handled by auth-callback.html page
    console.log('🔄 OAuth callback detected - handled by auth-callback.html');
} else if (currentPath !== '/login.html' && !currentPath.includes('login')) {
    // Require authentication for all other pages
    authGuard.requireAuth();
}

export default authGuard;
